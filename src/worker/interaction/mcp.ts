import type { JsonObject, JsonValue } from "../../contracts/index.js";
import type { Sandbox } from "../../runtime/sandbox/index.js";
import type { ToolRegistry } from "./tools.js";

/** Wrap a connected MCP SDK client. The application owns connect/auth/close. */
export interface McpClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: { type: "object"; [key: string]: unknown } }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}
export async function registerMcpTools(
  registry: ToolRegistry, server: string, client: McpClient, sandbox: Sandbox,
): Promise<() => void> {
  sandbox.assert("mcp", server);
  const remove: (() => boolean)[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) {
        remove.push(registry.register({
          name: `${server}__${tool.name}`, description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema as JsonObject, mcpServer: server,
          // MCP servers validate tool arguments against their advertised schema.
          validate: () => {},
          execute: async (arguments_) => {
            const result = await client.callTool({ name: tool.name, arguments: { ...arguments_ } });
            // Keep isError/content/structuredContent intact for the model.
            return JSON.parse(JSON.stringify(result)) as JsonValue;
          },
        }));
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP server repeated a pagination cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  } catch (error) {
    remove.forEach((unregister) => unregister());
    throw error;
  }
  return () => { remove.forEach((unregister) => unregister()); };
}
