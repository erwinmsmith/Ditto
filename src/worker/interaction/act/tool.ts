import type {
  ExternalResult, JsonObject, MessageContent, ToolCall, ToolDefinition,
} from "../../../contracts/common.js";
import type { WorkerContext } from "../../node.js";
import { createNodeScaffold } from "../../node-scaffold.js";

export const interactionToolNode = createNodeScaffold("INTERACTION.ACT.TOOL");

export interface RegisteredTool extends ToolDefinition {
  validate(arguments_: JsonObject): void;
  execute(arguments_: JsonObject, context: WorkerContext<unknown, unknown>): Promise<MessageContent>;
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
      .map(({ name, description, inputSchema }) => ({
        name,
        inputSchema,
        ...(description === undefined ? {} : { description }),
      }));
  }

  async call(call: ToolCall, context: WorkerContext<unknown, unknown>): Promise<ExternalResult> {
    context.services.sandbox.assert("tools", call.name);
    const tool = this.#tools.get(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    tool.validate(call.arguments);
    return { source: call.name, content: await tool.execute(call.arguments, context) };
  }
}

export function createToolHandler<R = undefined, C = undefined>(
  registry: ToolRegistry,
): import("../../node.js").NodeHandler<"INTERACTION.ACT.TOOL", R, C> {
  return (input, context) => registry.call(input.call, context);
}
