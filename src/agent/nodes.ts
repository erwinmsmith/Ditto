import type { AgentInput, AgentOutput } from "./contracts.js";
import { graph } from "../runtime/graph.js";
import type { ModelSelection } from "../runtime/config.js";
import type { ModelMessage, ToolCall } from "../providers/index.js";
import type { WorkerNodes } from "../worker.js";
import { SkillRegistry } from "./skills.js";
import { ToolRegistry } from "./tools.js";

export interface AgentNodeOptions {
  readonly model?: ModelSelection;
  readonly tools?: ToolRegistry;
  readonly skills?: SkillRegistry;
  readonly maxTurns?: number;
}

// Immutable plans are shared across turns and replicas; each run owns its outputs.
const skillPlan = graph<string>("agent-skill")
  .node("skill", "AGENT.SKILL", [], (name) => ({ name }));
const modelPlan = graph<readonly ModelMessage[]>("agent-turn")
  .node("response", "AGENT.GENERATE", [], (messages) => ({ messages }));
const toolPlan = graph<ToolCall>("agent-tool")
  .node("result", "AGENT.TOOL", [], (call) => ({ name: call.name, arguments: call.arguments }));

/** Functionality lives in Nodes. Runtime only supplies providers/config/permissions. */
export function createAgentNodes<R = undefined, C = undefined>(options: AgentNodeOptions = {}) {
  const tools = options.tools ?? new ToolRegistry();
  const skills = options.skills ?? new SkillRegistry();
  return {
    "AGENT.GENERATE": async (input, ctx) => {
      const selection = options.model ?? ctx.services.config.model;
      if (!selection?.provider || !selection.model) throw new Error("No model selected");
      return ctx.services.providers.get(selection.provider).generate({
        model: selection.model, messages: input.messages, tools: tools.list(ctx),
        signal: AbortSignal.timeout(ctx.services.config.timeoutMs),
      });
    },
    "AGENT.TOOL": async (input, ctx) => tools.call(input.name, input.arguments, ctx),
    "AGENT.SKILL": async (input, ctx) => skills.get(input.name, ctx.services.sandbox),
    "AGENT.RUN": async (input: AgentInput, ctx): Promise<AgentOutput> => {
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
