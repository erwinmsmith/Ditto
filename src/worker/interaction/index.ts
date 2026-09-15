export type * from "./contracts.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./mcp.js";

import type { WorkerNodes } from "../define-worker.js";
import { ToolRegistry } from "./tools.js";
import { SkillRegistry } from "./skills.js";

export interface InteractionNodeOptions {
  readonly tools?: ToolRegistry;
  readonly skills?: SkillRegistry;
}

/** Leaf capabilities only; model generation and repetition are composed by the application. */
export function createInteractionNodes<R = undefined, C = undefined>(options: InteractionNodeOptions = {}) {
  const tools = options.tools ?? new ToolRegistry();
  const skills = options.skills ?? new SkillRegistry();
  return {
    "INTERACTION.TOOL": async (input, ctx) => tools.call(input.name, input.arguments, ctx),
    "INTERACTION.TOOL_BATCH": async (input, ctx) => tools.callBatch(input.calls, ctx),
    "INTERACTION.SKILL": async (input, ctx) => skills.get(input.name, ctx.services.sandbox),
  } satisfies WorkerNodes<R, C>;
}
