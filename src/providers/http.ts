import type { ProviderConfig } from "../runtime/config.js";
import type { Sandbox } from "../sandbox/index.js";
import { jsonObject, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse, type ToolCall } from "./types.js";

export interface HttpProviderOptions extends ProviderConfig {
  readonly sandbox: Sandbox;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Text + function tools. Provider-specific/multimodal features use a custom adapter. */
export function createHttpProvider(options: HttpProviderOptions): ModelProvider {
  const baseUrl = new URL(options.baseUrl);
  if (!["https:", "http:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Invalid provider URL");
  }
  return {
    async generate(request): Promise<ModelResponse> {
      options.sandbox.assert("network", baseUrl.origin);
      const anthropic = options.kind === "anthropic";
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl.href.replace(/\/$/, "")}/${anthropic ? "messages" : "chat/completions"}`, {
        method: "POST", redirect: "error",
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        headers: { "content-type": "application/json", ...(anthropic
          ? { "anthropic-version": "2023-06-01", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) }
          : options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify(anthropic ? anthropicBody(request) : openaiBody(request)),
      });
      // Never echo response bodies: gateways may include credentials in their errors.
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Provider request failed (HTTP ${response.status})`);
      }
      const data = jsonObject(await response.json());
      if (anthropic) {
        if (data.stop_reason === "max_tokens") throw new Error("Provider output was truncated");
        if (!Array.isArray(data.content)) throw new Error("Invalid Anthropic response");
        const content: string[] = [];
        const toolCalls: ToolCall[] = [];
        for (const raw of data.content) {
          const block = jsonObject(raw);
          if (block.type === "text" && typeof block.text === "string") content.push(block.text);
          else if (block.type === "tool_use") toolCalls.push(parseCall(block.id, block.name, block.input));
          else throw new Error("Unsupported Anthropic response block");
        }
        return { content: content.join(""), toolCalls };
      }
      if (!Array.isArray(data.choices) || !data.choices.length) throw new Error("Invalid completion response");
      const choice = jsonObject(data.choices[0]);
      if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") throw new Error("Provider output was incomplete");
      const message = jsonObject(choice.message);
      if (message.content !== null && typeof message.content !== "string") throw new Error("Unsupported completion content");
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error("Invalid tool calls");
      const toolCalls = (message.tool_calls as readonly unknown[] | undefined ?? []).map((raw) => {
        const call = jsonObject(raw);
        const fn = jsonObject(call.function);
        if (call.type !== "function" || typeof fn.arguments !== "string") throw new Error("Unsupported tool call");
        return parseCall(call.id, fn.name, JSON.parse(fn.arguments));
      });
      return { content: message.content ?? "", toolCalls };
    },
  };
}
function parseCall(id: unknown, name: unknown, args: unknown): ToolCall {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw new Error("Invalid tool call identity");
  return { id, name, arguments: jsonObject(args) };
}
function openaiBody(request: ModelRequest): unknown {
  return { model: request.model, messages: request.messages.map((message) => {
    if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
    if (message.role === "assistant" && message.toolCalls?.length) return {
      role: "assistant", content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    };
    return { role: message.role, content: message.content };
  }), ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema,
  } })) } : {}), ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }) };
}
function anthropicBody(request: ModelRequest): unknown {
  const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = anthropicContent(message);
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  return { model: request.model, max_tokens: request.maxTokens ?? 4096,
    system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
    messages, ...(request.tools?.length ? { tools: request.tools.map((tool) => ({
      name: tool.name, description: tool.description, input_schema: tool.inputSchema,
    })) } : {}) };
}
function anthropicContent(message: Exclude<ModelMessage, { role: "system" }>): unknown[] {
  if (message.role === "tool") return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
  return [...(message.content ? [{ type: "text", text: message.content }] : []),
    ...(message.role === "assistant" ? message.toolCalls?.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })) ?? [] : [])];
}
