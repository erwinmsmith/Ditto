import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createDitto, createInteractionWorker, createReadOnlyCommandTools, graph, loop, type RegisteredTool } from "@ditto/core";
import type { SandboxExecutor } from "@ditto/core/runtime/sandbox";

const executeFile = promisify(execFile);
const commands = new Set([
  "uname", "printf", "false", "grep", "ls", "cat", "find", "head", "tail", "wc", "sort", "uniq", "cut", "stat", "file", "du", "pwd",
]);
export const readOnlyCommandTools = createReadOnlyCommandTools();

// Explicit, trusted local execution for this example; not an OS isolation boundary.
// Replace this object with a container/SSH executor when deploying elsewhere.
export const commandExecutor: SandboxExecutor = {
  async run({ command, args }, { workspace, signal }) {
    if (!commands.has(command)) throw new Error("Command not enabled in this example");
    try {
      const result = await executeFile(command, [...args], {
        cwd: workspace, env: { PATH: "/usr/bin:/bin" }, shell: false,
        encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
        ...(signal ? { signal } : {}),
      });
      return { ...result, exitCode: 0 };
    } catch (error) {
      // A program's nonzero exit is a tool outcome. Startup/timeout failures still throw.
      const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof result.code !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string") throw error;
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
    }
  },
};

export const linuxTool: RegisteredTool = {
  name: "linux", description: "Run an enabled Linux/macOS command with literal arguments",
  inputSchema: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["command", "args"] },
  effects: ["execute"], requiresApproval: false,
  validate(args) {
    if (typeof args.command !== "string" || !args.command.trim() || !Array.isArray(args.args) || !args.args.every(arg => typeof arg === "string")) {
      throw new Error("Expected command and string arguments");
    }
  },
  async execute(args, context) {
    const result = await context.services.sandbox.run({ command: args.command as string, args: args.args as string[] });
    return { status: result.exitCode === 0 ? "success" : "failed", content: result.stdout, structuredContent: result,
      ...(result.exitCode === 0 ? {} : { error: { code: "COMMAND_EXIT_NONZERO", message: `Command exited with code ${result.exitCode}` } }),
    };
  },
};

export const sha256Tool: RegisteredTool = {
  name: "sha256", description: "Hash text supplied by another tool",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  validate(args) { if (typeof args.text !== "string") throw new Error("Expected text"); },
  async execute(args) { return { status: "success", content: createHash("sha256").update(args.text as string).digest("hex") }; },
};

export interface CommandInput { id: string; command: string; args: readonly string[]; }
export const commandGraph = graph<CommandInput>("command-tools")
  .node("command", "INTERACTION.ACT.TOOL", [], input => ({ call: { id: input.id, name: "linux", arguments: { command: input.command, args: [...input.args] } } }))
  .node("commandObservation", "INTERACTION.OBSERVE", ["command"], (_input, { command }) => ({ result: command }));

export const toolGraph = commandGraph
  .node("hash", "INTERACTION.ACT.TOOL", ["commandObservation"], (input, { commandObservation }) => {
    const result = commandObservation.structuredContent;
    if (commandObservation.status !== "success" || !result || typeof result !== "object" || !("stdout" in result) || typeof result.stdout !== "string") {
      throw new Error("Command did not produce successful text output");
    }
    return { call: { id: `${input.id}:hash`, name: "sha256", arguments: { text: result.stdout } } };
  })
  .node("hashObservation", "INTERACTION.OBSERVE", ["hash"], (_input, { hash }) => ({ result: hash }))
  .node("deliver", "INTERACTION.OUTPUT", ["commandObservation", "hashObservation"], (input, { commandObservation, hashObservation }) => {
    if (hashObservation.status !== "success" || typeof hashObservation.message.content !== "string") throw new Error("Hash tool did not produce text");
    return { deliveryId: `${input.id}:delivery`,
      message: { role: "assistant", content: { command: commandObservation.structuredContent!, sha256: hashObservation.message.content } },
    };
  });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createDitto({
    sandbox: { tools: ["linux", "sha256", ...readOnlyCommandTools.map(tool => tool.name)], execute: true }, sandboxExecutor: commandExecutor,
    workers: [createInteractionWorker({ tools: [linuxTool, sha256Tool, ...readOnlyCommandTools], output: {
      async deliver(input) {
        console.log(JSON.stringify(input));
        return { deliveryId: input.deliveryId, status: "accepted" };
      },
    } })],
  });
  const inputs: CommandInput[] = [
    { id: "os", command: "uname", args: ["-s"] },
    { id: "literal", command: "printf", args: ["%s", "Ditto: spaces; $(uname) stay literal"] },
  ];
  try {
    const grep = await runtime.invoke("INTERACTION.ACT.TOOL", { call: {
      id: "grep-readme", name: "grep", arguments: { pattern: "Ditto", paths: ["README.md"], fixedStrings: true },
    } });
    console.log(JSON.stringify(await runtime.invoke("INTERACTION.OBSERVE", { result: grep })));
    await runtime.loop(loop({ graph: toolGraph, maxIterations: inputs.length,
      bind: (index: number) => inputs[index]!, update: index => index + 1, done: index => index === inputs.length,
    }), 0);
  } finally { await runtime.close(); }
}
