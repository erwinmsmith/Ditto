import { isAbsolute as isAbsolutePosix } from "node:path/posix";
import { isAbsolute as isAbsoluteWindows } from "node:path/win32";
import type { JsonObject, JsonValue } from "../../../../contracts/common.js";
import type { SandboxCommand } from "../../../../runtime/sandbox/index.js";
import type { RegisteredTool, ToolExecutionOutcome } from "./registry.js";

export interface ReadOnlyCommandToolOptions {
  readonly maxEntries?: number;
  readonly maxOutputBytes?: number;
  readonly maxErrorBytes?: number;
}

interface Limits {
  readonly maxEntries: number;
  readonly maxOutputBytes: number;
  readonly maxErrorBytes: number;
}

const defaults: Limits = Object.freeze({
  maxEntries: 1_000,
  maxOutputBytes: 64 * 1024,
  maxErrorBytes: 8 * 1024,
});

function positiveInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}

function limits(options: ReadOnlyCommandToolOptions): Limits {
  return Object.freeze({
    maxEntries: positiveInteger(options.maxEntries, defaults.maxEntries, 10_000, "maxEntries"),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, defaults.maxOutputBytes, 1024 * 1024, "maxOutputBytes"),
    maxErrorBytes: positiveInteger(options.maxErrorBytes, defaults.maxErrorBytes, 64 * 1024, "maxErrorBytes"),
  });
}

function exactKeys(input: JsonObject, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error("Unexpected command argument");
}

function text(value: JsonValue | undefined, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 1_024 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} must be a nonempty single-line string`);
  }
  return value;
}

function flag(value: JsonValue | undefined, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function relativePath(value: JsonValue | undefined, name: string, fallback?: string): string {
  const path = value === undefined ? fallback : text(value, name, true);
  if (path === undefined || isAbsolutePosix(path) || isAbsoluteWindows(path) || path.includes("\\")
    || path.split("/").some(segment => segment === ".." || !segment)) {
    throw new Error(`${name} must be a workspace-relative POSIX path`);
  }
  return path.startsWith("-") ? `./${path}` : path;
}

function paths(value: JsonValue | undefined): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) throw new Error("paths must contain 1 to 16 paths");
  return value.map((path, index) => relativePath(path, `paths[${index}]`));
}

function integer(value: JsonValue | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function delimiter(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || [...value].length !== 1 || /[\0\r\n]/.test(value)) {
    throw new Error("delimiter must be one character");
  }
  return value;
}

function utf8Prefix(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function bounded(value: string, maxBytes: number, maxEntries: number): { readonly value: string; readonly truncated: boolean } {
  const prefix = utf8Prefix(value, maxBytes);
  let end = prefix.value.length;
  let lines = 0;
  for (let index = 0; index < prefix.value.length; index++) {
    if (prefix.value[index] === "\n" && ++lines === maxEntries) {
      end = index + 1;
      break;
    }
  }
  return { value: prefix.value.slice(0, end), truncated: prefix.truncated || end < prefix.value.length };
}

function commandTool(
  name: string,
  description: string,
  inputSchema: JsonObject,
  build: (input: JsonObject) => SandboxCommand,
  outputLimits: Limits,
): RegisteredTool {
  return {
    name, description, inputSchema, effects: ["read", "execute"], requiresApproval: false,
    validate(input) { build(input); },
    async execute(input, context): Promise<ToolExecutionOutcome> {
      const command = build(input);
      const result = await context.services.sandbox.run(command);
      const stdout = bounded(result.stdout, outputLimits.maxOutputBytes, outputLimits.maxEntries);
      const stderr = bounded(result.stderr, outputLimits.maxErrorBytes, outputLimits.maxEntries);
      const structuredContent = {
        command: command.command, args: command.args, stdout: stdout.value, stderr: stderr.value,
        exitCode: result.exitCode, truncated: stdout.truncated || stderr.truncated,
      } as const;
      return {
        status: result.exitCode === 0 ? "success" : "failed",
        content: stdout.value,
        structuredContent,
        ...(result.exitCode === 0 ? {} : {
          error: { code: "COMMAND_EXIT_NONZERO", message: `Command exited with code ${result.exitCode}` },
        }),
      };
    },
  };
}

/** Optional read-only command tools. Applications still provide the isolated SandboxExecutor. */
export function createReadOnlyCommandTools(options: ReadOnlyCommandToolOptions = {}): readonly RegisteredTool[] {
  const outputLimits = limits(options);
  return Object.freeze([
    commandTool("grep", "Search text in workspace files", {
      type: "object", additionalProperties: false,
      properties: { pattern: { type: "string" }, paths: { type: "array", items: { type: "string" } },
        recursive: { type: "boolean" }, ignoreCase: { type: "boolean" }, fixedStrings: { type: "boolean" } },
      required: ["pattern", "paths"],
    }, input => {
      exactKeys(input, ["pattern", "paths", "recursive", "ignoreCase", "fixedStrings"]);
      const args = ["-n"];
      if (flag(input.recursive, "recursive")) args.push("-R");
      if (flag(input.ignoreCase, "ignoreCase")) args.push("-i");
      if (flag(input.fixedStrings, "fixedStrings")) args.push("-F");
      args.push("--", text(input.pattern, "pattern", true)!, ...paths(input.paths));
      return { command: "grep", args };
    }, outputLimits),
    commandTool("ls", "List one workspace directory", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, all: { type: "boolean" } },
    }, input => {
      exactKeys(input, ["path", "all"]);
      return { command: "ls", args: ["-1", ...(flag(input.all, "all") ? ["-a"] : []), "--", relativePath(input.path, "path", ".")] };
    }, outputLimits),
    commandTool("cat", "Read one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path"]);
      return { command: "cat", args: ["--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("find", "Find workspace files or directories by name", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, name: { type: "string" },
        type: { type: "string", enum: ["file", "directory"] }, maxDepth: { type: "integer", minimum: 0, maximum: 32 } },
    }, input => {
      exactKeys(input, ["path", "name", "type", "maxDepth"]);
      const kind = input.type;
      if (kind !== undefined && kind !== "file" && kind !== "directory") throw new Error("type must be file or directory");
      const args = [relativePath(input.path, "path", "."), "-maxdepth", String(integer(input.maxDepth, "maxDepth", 8, 0, 32))];
      if (kind !== undefined) args.push("-type", kind === "file" ? "f" : "d");
      const namePattern = text(input.name, "name");
      if (namePattern !== undefined) args.push("-name", namePattern);
      args.push("-print");
      return { command: "find", args };
    }, outputLimits),
    commandTool("head", "Read the first lines of one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 1_000 } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path", "lines"]);
      return { command: "head", args: ["-n", String(integer(input.lines, "lines", 20, 1, 1_000)), "--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("tail", "Read the last lines of one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 1_000 } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path", "lines"]);
      return { command: "tail", args: ["-n", String(integer(input.lines, "lines", 20, 1, 1_000)), "--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("wc", "Count lines, words, or bytes in one workspace file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, metric: { type: "string", enum: ["lines", "words", "bytes"] } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path", "metric"]);
      const metric = input.metric ?? "lines";
      if (metric !== "lines" && metric !== "words" && metric !== "bytes") throw new Error("metric must be lines, words, or bytes");
      return { command: "wc", args: [metric === "lines" ? "-l" : metric === "words" ? "-w" : "-c", "--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("sort", "Sort lines from one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, reverse: { type: "boolean" }, numeric: { type: "boolean" }, unique: { type: "boolean" } },
      required: ["path"],
    }, input => {
      exactKeys(input, ["path", "reverse", "numeric", "unique"]);
      const args: string[] = [];
      if (flag(input.reverse, "reverse")) args.push("-r");
      if (flag(input.numeric, "numeric")) args.push("-n");
      if (flag(input.unique, "unique")) args.push("-u");
      args.push("--", relativePath(input.path, "path"));
      return { command: "sort", args };
    }, outputLimits),
    commandTool("uniq", "Filter adjacent duplicate lines from one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, count: { type: "boolean" }, ignoreCase: { type: "boolean" } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path", "count", "ignoreCase"]);
      const args: string[] = [];
      if (flag(input.count, "count")) args.push("-c");
      if (flag(input.ignoreCase, "ignoreCase")) args.push("-i");
      args.push("--", relativePath(input.path, "path"));
      return { command: "uniq", args };
    }, outputLimits),
    commandTool("cut", "Select delimited fields from one workspace text file", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, delimiter: { type: "string" }, fields: { type: "string" } }, required: ["path", "fields"],
    }, input => {
      exactKeys(input, ["path", "delimiter", "fields"]);
      const fields = text(input.fields, "fields", true)!;
      if (!/^\d+(?:-\d*)?(?:,\d+(?:-\d*)?)*$/.test(fields)) throw new Error("fields must be comma-separated field numbers or ranges");
      const separator = delimiter(input.delimiter);
      return { command: "cut", args: [...(separator === undefined ? [] : ["-d", separator]), "-f", fields, "--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("stat", "Read metadata for one workspace path", {
      type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path"]);
      return { command: "stat", args: ["--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("file", "Identify the type of one workspace file", {
      type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path"]);
      return { command: "file", args: ["--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("du", "Summarize disk usage below one workspace path", {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string" }, maxDepth: { type: "integer", minimum: 0, maximum: 32 } }, required: ["path"],
    }, input => {
      exactKeys(input, ["path", "maxDepth"]);
      return { command: "du", args: ["-k", `--max-depth=${integer(input.maxDepth, "maxDepth", 1, 0, 32)}`, "--", relativePath(input.path, "path")] };
    }, outputLimits),
    commandTool("pwd", "Return the executor workspace directory", {
      type: "object", additionalProperties: false, properties: {},
    }, input => {
      exactKeys(input, []);
      return { command: "pwd", args: [] };
    }, outputLimits),
  ]);
}
