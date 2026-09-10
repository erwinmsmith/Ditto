import type { JsonObject, JsonValue } from "../contracts/index.js";
import type { WorkerContext } from "../node.js";
import { jsonObject, type ToolSchema } from "../providers/index.js";

export interface ToolDefinition extends ToolSchema {
  /** Required for local tools: reject invalid model-generated arguments before effects. */
  validate(arguments_: JsonObject): void;
  execute(arguments_: JsonObject, context: WorkerContext<unknown, unknown>): Promise<JsonValue>;
  readonly mcpServer?: string;
}
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): () => boolean {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.#tools.has(tool.name)) throw new Error(`Invalid or duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
    return () => this.#tools.get(tool.name) === tool && this.#tools.delete(tool.name);
  }
  list(context: WorkerContext<unknown, unknown>): readonly ToolSchema[] {
    return [...this.#tools.values()].filter((tool) => context.services.sandbox.allows("tools", tool.name)
      && (!tool.mcpServer || context.services.sandbox.allows("mcp", tool.mcpServer)))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
  async call(name: string, arguments_: JsonObject, context: WorkerContext<unknown, unknown>): Promise<JsonValue> {
    context.services.sandbox.assert("tools", name);
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (tool.mcpServer) context.services.sandbox.assert("mcp", tool.mcpServer);
    jsonObject(arguments_);
    tool.validate(arguments_);
    return tool.execute(arguments_, context);
  }
}
