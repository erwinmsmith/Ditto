import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { SandboxExecutor } from "./index.js";

export interface LocalSandboxExecutorOptions {
  /** Exact executable names or absolute paths; no shell command strings. */
  readonly commands: readonly string[];
  readonly timeoutMs?: number;
  /** Combined stdout/stderr byte limit. */
  readonly maxOutputBytes?: number;
  /** Explicit environment additions; parent environment is not inherited. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Explicit trusted host execution. Replace with an OS/container executor for isolation. */
export function createLocalSandboxExecutor(options: LocalSandboxExecutorOptions): SandboxExecutor {
  const timeoutMs = options.timeoutMs ?? 5000, maxOutputBytes = options.maxOutputBytes ?? 65536;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    throw new Error("Invalid local executor timeout or output limit");
  }
  if (!Array.isArray(options.commands) || options.commands.some(command => typeof command !== "string"
    || !command.trim() || command.includes("\0") || (!isAbsolute(command) && /[/\\]/.test(command)))) {
    throw new Error("Commands must be executable names or absolute paths");
  }
  const commands = new Set(options.commands);
  const env = Object.freeze({ PATH: "/usr/bin:/bin", ...options.env });
  for (const [key, value] of Object.entries(env)) {
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid executor environment");
  }
  return Object.freeze({
    async run(command, { workspace, signal }) {
      signal?.throwIfAborted();
      if (!commands.has(command.command)) throw new Error("Command is not enabled in this executor");
      if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid command arguments");
      return new Promise((resolve, reject) => {
        // Node may mutate the supplied env when propagating coverage settings.
        const child = spawn(command.command, [...command.args], {
          cwd: workspace, env: { NODE_V8_COVERAGE: undefined, ...env }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let bytes = 0, failed = false, failure: unknown;
        const stop = (error: unknown) => {
          if (failed) return;
          failed = true; failure = error;
          child.kill("SIGKILL"); // Bound the directly spawned process, even if it ignores SIGTERM.
          child.stdout.destroy(); child.stderr.destroy();
        };
        const abort = () => stop(signal?.reason);
        const timer = setTimeout(() => stop(new DOMException("Command timed out", "TimeoutError")), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const collect = (chunks: Buffer[], chunk: Buffer) => {
          if (failed) return;
          bytes += chunk.length;
          if (bytes > maxOutputBytes) stop(new Error("Command output exceeds maxOutputBytes"));
          else chunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.on("error", stop);
        child.on("close", (code, killedBy) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (failed) reject(failure);
          else if (code === null) reject(new Error(`Command terminated by ${killedBy ?? "unknown signal"}`));
          else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code });
        });
      });
    },
  } satisfies SandboxExecutor);
}
