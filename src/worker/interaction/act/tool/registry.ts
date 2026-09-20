import type {
  ExternalResult, JsonObject, ToolCall, ToolDefinition,
} from "../../../../contracts/common.js";
import type { WorkerContext } from "../../../node.js";
import { externalResult, nonempty } from "../../validation.js";

export type ToolExecutionOutcome = Omit<ExternalResult, "callId" | "source">;

export interface RegisteredTool extends ToolDefinition {
  validate(arguments_: JsonObject): void;
  execute(arguments_: JsonObject, context: WorkerContext<unknown, unknown>): Promise<ToolExecutionOutcome>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): () => boolean {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.#tools.has(tool.name)) {
      throw new Error(`Invalid or duplicate tool: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return () => this.#tools.get(tool.name) === tool && this.#tools.delete(tool.name);
  }

  list(context: WorkerContext<unknown, unknown>): readonly ToolDefinition[] {
    return [...this.#tools.values()]
      .filter((tool) => context.services.sandbox.allows("tools", tool.name))
      .map(({ name, description, inputSchema, effects, requiresApproval }) => ({
        name,
        inputSchema,
        ...(description === undefined ? {} : { description }),
        ...(effects === undefined ? {} : { effects }),
        ...(requiresApproval === undefined ? {} : { requiresApproval }),
      }));
  }

  async call(call: ToolCall, context: WorkerContext<unknown, unknown>): Promise<ExternalResult> {
    nonempty(call.id, "call.id");
    context.services.sandbox.assert("tools", call.name);
    const tool = this.#tools.get(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    tool.validate(call.arguments);
    const outcome = await tool.execute(call.arguments, context);
    const result = { ...outcome, callId: call.id, source: call.name };
    externalResult(result);
    return result;
  }
}
