import type { MessageContent, ModelOutput, ModelProvider, ProviderRequest, ToolCall } from "../../../contracts/common.js";
import type { ProviderConfig } from "../../../runtime/config.js";
import type { Sandbox } from "../../../runtime/sandbox/index.js";
import { jsonObject } from "./types.js";

export interface HttpProviderOptions extends ProviderConfig {
  readonly sandbox: Sandbox;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** Lightweight text/tool HTTP adapter. Vendor SDKs remain optional integrations. */
export function createHttpProvider(options: HttpProviderOptions): ModelProvider {
  const baseUrl = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("Invalid provider URL");
  }
  return {
    async invoke(request): Promise<ModelOutput> {
      options.sandbox.assert("network", baseUrl.origin);
      const anthropic = options.kind === "anthropic";
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const response = await (options.fetch ?? globalThis.fetch)(
        `${baseUrl.href.replace(/\/$/, "")}/${anthropic ? "messages" : "chat/completions"}`,
        {
          method: "POST",
          redirect: "error",
          signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
          headers: { "content-type": "application/json", ...(anthropic
            ? { "anthropic-version": "2023-06-01", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) }
            : options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify(anthropic ? anthropicBody(request) : openaiBody(request)),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Provider request failed (HTTP ${response.status})`);
      }
      return anthropic ? parseAnthropic(await response.json()) : parseOpenAi(await response.json());
    },
  };
}

function contentText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function openaiBody(request: ProviderRequest): unknown {
  return {
    model: request.model,
    messages: request.input.messages.map((message) => ({
      role: message.role,
      content: contentText(message.content),
      ...(message.role === "tool" && message.name ? { tool_call_id: message.name } : {}),
    })),
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({
      type: "function", function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema,
      },
    })) } : {}),
    ...(request.maxTokens === undefined ? {} : { max_completion_tokens: request.maxTokens }),
  };
}

function anthropicBody(request: ProviderRequest): unknown {
  const messages = request.input.messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: contentText(message.content),
  }));
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    system: request.input.messages.filter((message) => message.role === "system")
      .map((message) => contentText(message.content)).join("\n\n"),
    messages,
    ...(request.tools?.length ? { tools: request.tools.map((tool) => ({
      name: tool.name, description: tool.description, input_schema: tool.inputSchema,
    })) } : {}),
  };
}

function parseCall(id: unknown, name: unknown, args: unknown): ToolCall {
  if (typeof id !== "string" || !id || typeof name !== "string" || !name) throw new Error("Invalid tool call identity");
  return { id, name, arguments: jsonObject(args) };
}

function parseOpenAi(raw: unknown): ModelOutput {
  const data = jsonObject(raw);
  if (!Array.isArray(data.choices) || !data.choices.length) throw new Error("Invalid completion response");
  const choice = jsonObject(data.choices[0]);
  const message = jsonObject(choice.message);
  if (message.content !== null && typeof message.content !== "string") throw new Error("Unsupported completion content");
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((entry) => {
    const call = jsonObject(entry);
    const fn = jsonObject(call.function);
    if (typeof fn.arguments !== "string") throw new Error("Unsupported tool call");
    return parseCall(call.id, fn.name, JSON.parse(fn.arguments));
  });
  return {
    message: { role: "assistant", content: typeof message.content === "string" ? message.content : "" },
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
  };
}

function parseAnthropic(raw: unknown): ModelOutput {
  const data = jsonObject(raw);
  if (!Array.isArray(data.content)) throw new Error("Invalid Anthropic response");
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const entry of data.content) {
    const block = jsonObject(entry);
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block.type === "tool_use") toolCalls.push(parseCall(block.id, block.name, block.input));
  }
  return {
    message: { role: "assistant", content: text.join("") },
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof data.stop_reason === "string" ? { finishReason: data.stop_reason } : {}),
  };
}
