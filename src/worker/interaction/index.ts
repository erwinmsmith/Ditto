export type * from "./contracts.js";
export * from "./act/index.js";
export * from "./observe.js";
export * from "./output.js";

import type { WorkerNodes } from "../define-worker.js";
import { createMcpHandler, McpRegistry } from "./act/mcp.js";
import { createToolHandler, ToolRegistry } from "./act/tool/index.js";
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
