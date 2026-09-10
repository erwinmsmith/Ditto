import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";

export type PermissionKind = "tools" | "mcp" | "skills" | "network";
export interface SandboxPolicy {
  readonly tools?: readonly string[];
  readonly mcp?: readonly string[];
  readonly skills?: readonly string[];
  /** Exact URL origins, e.g. https://api.openai.com. */
  readonly network?: readonly string[];
  readonly read?: boolean;
  readonly write?: boolean;
  readonly execute?: boolean;
}
export interface SandboxCommand { readonly command: string; readonly args: readonly string[] }
/** Implement with a container/OS sandbox; never implicitly run a host shell. */
export interface SandboxExecutor {
  run(command: SandboxCommand, options: { workspace: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class PermissionDeniedError extends Error {
  constructor(permission: string) { super(`Permission denied: ${permission}`); this.name = "PermissionDeniedError"; }
}

/** Cooperative capability guard, not an OS security boundary for arbitrary JS. */
export class Sandbox {
  readonly policy: SandboxPolicy;
  readonly workspace: string;
  constructor(workspace: string, policy: SandboxPolicy = {}, readonly executor?: SandboxExecutor) {
    this.workspace = resolve(workspace);
    this.policy = Object.freeze({ ...policy,
      ...Object.fromEntries((["tools", "mcp", "skills", "network"] as const)
        .filter((key) => policy[key] !== undefined).map((key) => [key, Object.freeze([...policy[key]!])])),
    });
  }
  allows(kind: PermissionKind, name: string): boolean {
    return this.policy[kind]?.some((entry) => entry === "*" || entry === name) ?? false;
  }
  assert(kind: PermissionKind, name: string): void {
    if (!this.allows(kind, name)) throw new PermissionDeniedError(`${kind}:${name}`);
  }
  async #path(path: string, writing = false): Promise<string> {
    const root = await realpath(this.workspace);
    const candidate = resolve(this.workspace, path);
    const inside = (target: string): boolean => {
      const rel = relative(root, target);
      return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
    };
    let target: string;
    try { target = await realpath(candidate); }
    catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink must not be followed when creating a new file.
      const stat = await lstat(candidate).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return undefined;
      });
      if (stat?.isSymbolicLink()) throw new PermissionDeniedError("symlink");
      target = resolve(await realpath(dirname(candidate)), basename(candidate));
    }
    if (!inside(target)) throw new PermissionDeniedError("workspace path");
    return target;
  }
  async readText(path: string): Promise<string> {
    if (!this.policy.read) throw new PermissionDeniedError("filesystem:read");
    return readFile(await this.#path(path), "utf8");
  }
  async writeText(path: string, content: string): Promise<void> {
    if (!this.policy.write) throw new PermissionDeniedError("filesystem:write");
    await writeFile(await this.#path(path, true), content, "utf8");
  }
  async run(command: SandboxCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.policy.execute || !this.executor) throw new PermissionDeniedError("execution requires an enabled SandboxExecutor");
    return this.executor.run(command, { workspace: await realpath(this.workspace), ...(signal ? { signal } : {}) });
  }
}
