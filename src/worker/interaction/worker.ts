import { defineWorker, type WorkerDefinition, type WorkerNodes } from "../define-worker.js";
import { createMcpHandler, McpRegistry, type McpClient } from "./act/mcp.js";
import { createToolHandler, ToolRegistry, type RegisteredTool } from "./act/tool/index.js";
import { observeExternalResult } from "./observe.js";
import { createOutputHandler, type OutputSink } from "./output.js";

export interface InteractionNodeOptions {
  readonly tools?: ToolRegistry;
  readonly mcp?: McpRegistry;
  readonly output?: OutputSink;
}

/** Concrete TOOL/OBSERVE handlers plus resource-backed MCP and OUTPUT handlers. */
export function createInteractionNodes<R = undefined, C = undefined>(
  options: InteractionNodeOptions = {},
): WorkerNodes<R, C> {
  const tools = options.tools ?? new ToolRegistry();
  const nodes: WorkerNodes<R, C> = {
    "INTERACTION.ACT.TOOL": createToolHandler<R, C>(tools),
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
    ...(options.mcp ? { "INTERACTION.ACT.MCP": createMcpHandler<R, C>(options.mcp) } : {}),
    ...(options.output ? { "INTERACTION.OUTPUT": createOutputHandler<R, C>(options.output) } : {}),
  };
  return nodes;
}

export interface InteractionOptions {
  readonly tools?: ToolRegistry | readonly RegisteredTool[];
  readonly mcp?: McpRegistry | Readonly<Record<string, McpClient>>;
  readonly output?: OutputSink;
  readonly concurrency?: number;
}

/** Configure capabilities inside the Worker; Graph and Loop remain independent of SDKs. */
export function createInteractionWorker(options: InteractionOptions = {}): WorkerDefinition {
  const tools = options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry();
  if (options.tools && !(options.tools instanceof ToolRegistry)) {
    for (const tool of options.tools) tools.register(tool);
  }
  let mcp: McpRegistry | undefined;
  if (options.mcp instanceof McpRegistry) mcp = options.mcp;
  else if (options.mcp) {
    mcp = new McpRegistry();
    for (const [server, client] of Object.entries(options.mcp)) mcp.register(server, client);
  }
  return defineWorker({
    type: "INTERACTION",
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    nodes: createInteractionNodes({
      tools,
      ...(mcp ? { mcp } : {}),
      ...(options.output ? { output: options.output } : {}),
    }),
  });
}
