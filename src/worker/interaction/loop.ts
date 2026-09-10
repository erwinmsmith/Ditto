import type { InteractionRunInput, InteractionRunOutput } from "./contracts.js";
import { graph } from "../../runtime/graph.js";
import type { ModelSelection } from "../../runtime/config.js";
import type { ModelMessage, ToolCall } from "../reasoning/providers/index.js";
import type { WorkerNodes } from "../define-worker.js";
import { SkillRegistry } from "./skills.js";
import { ToolRegistry } from "./tools.js";
import { createGenerateNode } from "../reasoning/generate.js";

export interface InteractionNodeOptions {
  readonly model?: ModelSelection;
  readonly tools?: ToolRegistry;
  readonly skills?: SkillRegistry;
  readonly maxTurns?: number;
}

// Immutable plans are shared across turns and replicas; each run owns its outputs.
const skillPlan = graph<string>("agent-skill")
  .node("skill", "INTERACTION.SKILL", [], (name) => ({ name }));
const modelPlan = graph<readonly ModelMessage[]>("agent-turn")
  .node("response", "REASONING.GENERATE", [], (messages) => ({ messages }));
const toolPlan = graph<ToolCall>("agent-tool")
  .node("result", "INTERACTION.TOOL", [], (call) => ({ name: call.name, arguments: call.arguments }));

/** Functionality lives in Nodes. Runtime only supplies providers/config/permissions. */
export function createInteractionNodes<R = undefined, C = undefined>(options: InteractionNodeOptions = {}) {
  const tools = options.tools ?? new ToolRegistry();
  const skills = options.skills ?? new SkillRegistry();
  return {
    // Explicitly compose a reasoning-owned Node into this local interaction loop.
    "REASONING.GENERATE": createGenerateNode<R, C>({
      ...(options.model ? { model: options.model } : {}), tools: (ctx) => tools.list(ctx),
    }),
    "INTERACTION.TOOL": async (input, ctx) => tools.call(input.name, input.arguments, ctx),
    "INTERACTION.SKILL": async (input, ctx) => skills.get(input.name, ctx.services.sandbox),
    "INTERACTION.RUN": async (input: InteractionRunInput, ctx): Promise<InteractionRunOutput> => {
      const maxTurns = options.maxTurns ?? ctx.services.config.maxTurns;
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer");
      const messages: ModelMessage[] = [];
      for (const name of input.skills ?? []) {
        const { skill } = await ctx.run(skillPlan, name);
        messages.push({ role: "system", content: skill.instructions });
      }
      messages.push(...input.messages);
      for (let turns = 1; turns <= maxTurns; turns++) {
        const { response } = await ctx.run(modelPlan, messages);
        messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
        if (!response.toolCalls.length) return { content: response.content, messages, turns };
        // Do not perform effects when there is no model turn left to consume results.
        if (turns === maxTurns) throw new Error("Agent turn limit reached");
        const ids = new Set<string>();
        const offered = new Set(tools.list(ctx).map((tool) => tool.name));
        for (const call of response.toolCalls) {
          if (!call.id || ids.has(call.id) || !offered.has(call.name)) throw new Error("Invalid or unavailable model tool call");
          ids.add(call.id);
        }
        // Sequential tool effects are intentional; parallelism belongs in explicit Graphs.
        for (const call of response.toolCalls) {
          const { result } = await ctx.run(toolPlan, call);
          messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
        }
      }
      throw new Error("Agent turn limit reached");
    },
  } satisfies WorkerNodes<R, C>;
}
