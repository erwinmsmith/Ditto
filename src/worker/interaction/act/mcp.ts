import type { ExternalResult, JsonObject, McpCapability } from "../../../contracts/common.js";
import type { Sandbox } from "../../../runtime/sandbox/index.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { InteractionMcpInput, InteractionMcpOutput } from "../contracts.js";

export const interactionMcpNode = createNodeScaffold("INTERACTION.ACT.MCP");

/** Structural boundary for an optional MCP SDK client. */
export interface McpClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: JsonObject }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

export class McpRegistry {
  readonly #clients = new Map<string, McpClient>();

  register(server: string, client: McpClient): () => boolean {
    if (!server || this.#clients.has(server)) throw new Error(`Duplicate or empty MCP server: ${server}`);
    this.#clients.set(server, client);
    return () => this.#clients.get(server) === client && this.#clients.delete(server);
  }

  async execute(input: InteractionMcpInput, sandbox: Sandbox): Promise<InteractionMcpOutput> {
    if (input.operation === "invoke") {
      const client = this.#client(input.server, sandbox);
      const result: ExternalResult = {
        source: `${input.server}:${input.call.name}`,
        content: JSON.parse(JSON.stringify(await client.callTool({
          name: input.call.name,
          arguments: { ...input.call.arguments },
        }))) as import("../../../contracts/common.js").JsonValue,
      };
      return { operation: "invoke", result };
    }
    const servers = input.server ? [input.server] : [...this.#clients.keys()];
    const capabilities: McpCapability[] = [];
    for (const server of servers) capabilities.push(...await this.#discover(server, sandbox));
    return { operation: "discover", capabilities };
  }

  #client(server: string, sandbox: Sandbox): McpClient {
    sandbox.assert("mcp", server);
    const client = this.#clients.get(server);
    if (!client) throw new Error(`Unknown MCP server: ${server}`);
    return client;
  }

  async #discover(server: string, sandbox: Sandbox): Promise<readonly McpCapability[]> {
    const client = this.#client(server, sandbox);
    const capabilities: McpCapability[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) capabilities.push({
        server,
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      });
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP server repeated a pagination cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return capabilities;
  }
}

export function createMcpHandler<R = undefined, C = undefined>(
  registry: McpRegistry,
): import("../../node.js").NodeHandler<"INTERACTION.ACT.MCP", R, C> {
  return (input, context) => registry.execute(input, context.services.sandbox);
}
