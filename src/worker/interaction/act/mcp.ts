import type { ExternalResult, InteractionError, JsonObject, McpCapability, MessageContent, Reference, JsonValue } from "../../../contracts/common.js";
import type { Sandbox } from "../../../runtime/sandbox/index.js";
import { createNodeScaffold } from "../../node-scaffold.js";
import type { InteractionMcpInput, InteractionMcpOutput } from "../contracts.js";
import { externalResult, jsonValue, nonempty } from "../validation.js";

export const interactionMcpNode = createNodeScaffold("INTERACTION.ACT.MCP");

/** Structural boundary for an optional MCP SDK client. */
export interface McpClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: JsonObject; outputSchema?: JsonObject }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: JsonObject }): Promise<McpToolResult>;
}

export interface McpToolResult {
  content?: MessageContent;
  structuredContent?: JsonValue;
  references?: readonly Reference[];
  isError?: boolean;
  error?: InteractionError;
}

export interface McpRegistryOptions { maxDiscoveryPages?: number; maxCapabilities?: number; }

const defaultMcpError: InteractionError = { code: "MCP_TOOL_ERROR", message: "MCP tool reported an execution error" };

export class McpRegistry {
  readonly #clients = new Map<string, McpClient>();

  constructor(readonly options: McpRegistryOptions = {}) {
    for (const value of [options.maxDiscoveryPages, options.maxCapabilities]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("MCP discovery limits must be positive integers");
    }
  }

  register(server: string, client: McpClient): () => boolean {
    nonempty(server, "server");
    if (this.#clients.has(server)) throw new Error(`Duplicate MCP server: ${server}`);
    this.#clients.set(server, client);
    return () => this.#clients.get(server) === client && this.#clients.delete(server);
  }

  async execute(input: InteractionMcpInput, sandbox: Sandbox): Promise<InteractionMcpOutput> {
    if (input.operation === "invoke") {
      nonempty(input.call.id, "call.id"); nonempty(input.call.name, "call.name");
      const client = this.#client(input.server, sandbox);
      const response = await client.callTool({ name: input.call.name, arguments: { ...input.call.arguments } });
      if (!response || typeof response !== "object") throw new Error("Invalid MCP tool result");
      if (response.isError !== undefined && typeof response.isError !== "boolean") throw new Error("Invalid MCP isError");
      const result: ExternalResult = externalResult({
        callId: input.call.id,
        source: `${input.server}:${input.call.name}`,
        status: response.isError ? "failed" : "success",
        ...(response.content === undefined ? {} : { content: response.content }),
        ...(response.structuredContent === undefined ? {} : { structuredContent: response.structuredContent }),
        ...(response.references === undefined ? {} : { references: response.references }),
        ...(response.error === undefined ? {} : { error: response.error }),
      }, response.isError ? defaultMcpError : undefined);
      return { operation: "invoke", result };
    }
    const servers = input.server ? [input.server] : [...this.#clients.keys()];
    const capabilities: McpCapability[] = [];
    const budget = { pages: 0, capabilities: 0 };
    for (const server of servers) capabilities.push(...await this.#discover(server, sandbox, budget));
    return { operation: "discover", capabilities };
  }

  #client(server: string, sandbox: Sandbox): McpClient {
    nonempty(server, "server");
    sandbox.assert("mcp", server);
    const client = this.#clients.get(server);
    if (!client) throw new Error(`Unknown MCP server: ${server}`);
    return client;
  }

  async #discover(server: string, sandbox: Sandbox, budget: { pages: number; capabilities: number }): Promise<readonly McpCapability[]> {
    const client = this.#client(server, sandbox);
    const capabilities: McpCapability[] = [];
    const cursors = new Set<string>();
    const maxPages = this.options.maxDiscoveryPages ?? 100;
    const maxCapabilities = this.options.maxCapabilities ?? 1000;
    let cursor: string | undefined;
    do {
      if (budget.pages >= maxPages) throw new Error("MCP discovery page limit exceeded");
      const page = await client.listTools(cursor ? { cursor } : {});
      budget.pages++;
      if (!page || !Array.isArray(page.tools)) throw new Error("Invalid MCP tool page");
      if (budget.capabilities + page.tools.length > maxCapabilities) throw new Error("MCP capability limit exceeded");
      for (const tool of page.tools) capabilities.push({
        server,
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      });
      budget.capabilities += page.tools.length;
      for (const tool of page.tools) {
        nonempty(tool.name, "MCP tool name");
        if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("Invalid MCP inputSchema");
        jsonValue(tool.inputSchema, "MCP inputSchema");
        if (tool.outputSchema !== undefined) {
          if (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema)) throw new Error("Invalid MCP outputSchema");
          jsonValue(tool.outputSchema, "MCP outputSchema");
        }
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) nonempty(cursor, "MCP cursor");
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
