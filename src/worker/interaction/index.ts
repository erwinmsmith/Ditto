export type * from "./contracts.js";
export * from "./act/index.js";
export * from "./observe.js";
export * from "./communicate.js";
export * from "./output.js";

import type { WorkerNodes } from "../define-worker.js";
import { createMcpHandler, McpRegistry } from "./act/mcp.js";
import { createToolHandler, ToolRegistry } from "./act/tool.js";

export interface InteractionNodeOptions {
  readonly tools?: ToolRegistry;
  readonly mcp?: McpRegistry;
}

/** Optional concrete ACT handlers; the other Interaction leaves remain application-defined. */
export function createInteractionNodes<R = undefined, C = undefined>(
  options: InteractionNodeOptions = {},
): WorkerNodes<R, C> {
  const tools = options.tools ?? new ToolRegistry();
  const nodes: WorkerNodes<R, C> = {
    "INTERACTION.ACT.TOOL": createToolHandler<R, C>(tools),
    ...(options.mcp ? { "INTERACTION.ACT.MCP": createMcpHandler<R, C>(options.mcp) } : {}),
  };
  return nodes;
}
