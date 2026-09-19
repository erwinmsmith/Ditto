import type { ActionRequest, Message, Usage } from "../types.js";
import type { SampleInput, SampleOutput } from "../reasoning/sample/types.js";
import type { ProviderProtocol, ModelStreamEvent } from "./types.js";
import { InferError, object, text, list, modelOutput } from "../validation.js";
function wireMessage(message: Message): unknown {
  if (message.role === "tool") {
    text(message.metadata?.actionRequestId, "tool message metadata.actionRequestId");
    return { role: "tool", content: message.content, tool_call_id: message.metadata.actionRequestId };
  }
  if (message.role === "assistant" && message.metadata?.actionRequests !== undefined) {
    list(message.metadata.actionRequests, "metadata.actionRequests");
    return { role: "assistant", content: message.content || null,
      ...(message.metadata.provider === "openai-compatible" && typeof message.metadata.reasoningContent === "string" ? { reasoning_content: message.metadata.reasoningContent } : {}), tool_calls: message.metadata.actionRequests.map(raw => {
      const a = object(raw); text(a.id, "action.id"); text(a.name, "action.name"); object(a.arguments);
      return { id: a.id, type: "function", function: { name: a.name, arguments: JSON.stringify(a.arguments) } };
    }) };
  }
  return { role: message.role, content: message.content };
}
function body(input: SampleInput, streaming: boolean): unknown {
  const g = input.generation;
  return {
    ...input.model.providerOptions,
    model: input.model.model, messages: input.messages.map(wireMessage), stream: streaming,
    ...(streaming ? { stream_options: { include_usage: true } } : {}),
    tools: input.actions?.length ? input.actions.map(a => ({ type: "function", function: { name: a.name, description: a.description ?? "", parameters: a.inputSchema } })) : undefined,
    ...(g?.temperature !== undefined ? { temperature: g.temperature } : {}),
    ...(g?.topP !== undefined ? { top_p: g.topP } : {}), ...(g?.topK !== undefined ? { top_k: g.topK } : {}),
    ...(g?.maxTokens !== undefined ? { max_completion_tokens: g.maxTokens } : {}),
    ...(g?.stop !== undefined ? { stop: g.stop } : {}), ...(g?.seed !== undefined ? { seed: g.seed } : {}),
    // SAMPLE always represents one candidate, even if a provider option tried to set n.
    n: 1,
  };
}
function readUsage(raw: unknown): Usage | undefined {
  if (raw === undefined || raw === null) return undefined;
  const u = object(raw); const result: Usage = {};
  for (const [source, target] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"], ["total_tokens", "totalTokens"]] as const) {
    if (u[source] !== undefined) result[target] = u[source] as number;
  }
  if (u.prompt_tokens_details) { const d = object(u.prompt_tokens_details); if (d.cached_tokens !== undefined) result.cachedInputTokens = d.cached_tokens as number; }
  if (u.completion_tokens_details) { const d = object(u.completion_tokens_details); if (d.reasoning_tokens !== undefined) result.reasoningTokens = d.reasoning_tokens as number; }
  return result;
}
function finish(reason: unknown): SampleOutput["finishReason"] {
  if (reason === "stop" || reason === "length") return reason;
  if (reason === "tool_calls") return "action_request";
  if (reason === "content_filter") return "error";
  throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported or missing provider finish reason");
}
function action(raw: unknown): ActionRequest {
  const call = object(raw); text(call.id, "tool call id");
  if (call.type !== "function") throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported tool call type");
  const fn = object(call.function); text(fn.name, "function name"); text(fn.arguments, "function arguments");
  return { id: call.id, name: fn.name, arguments: object(JSON.parse(fn.arguments)) };
}
export const openai: ProviderProtocol = {
  path: () => "/chat/completions",
  headers: key => key ? { authorization: `Bearer ${key}` } : {},
  body,
  parse(data) { return modelOutput(() => {
        const d = object(data); list(d.choices, "choices"); const c = object(d.choices[0]); const m = object(c.message);
        if (m.content !== null && typeof m.content !== "string" && !Array.isArray(m.content)) throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported message content");
        if (m.tool_calls !== undefined) list(m.tool_calls, "tool_calls");
        const calls = (m.tool_calls as unknown[] | undefined)?.map(action);
        const usage = readUsage(d.usage);
        return { message: { role: "assistant", content: m.content ?? "",
          ...(calls?.length && typeof m.reasoning_content === "string" ? { metadata: { provider: "openai-compatible", reasoningContent: m.reasoning_content } } : {}) }, finishReason: finish(c.finish_reason),
          ...(calls?.length ? { actionRequests: calls } : {}), ...(usage ? { usage } : {}) };
  }); },
  async *stream(events): AsyncIterable<ModelStreamEvent> {
      let content = ""; let reasoningContent = ""; let reason: unknown; let usage: Usage | undefined; let done = false;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      function consume(data: string): string | undefined {
        if (!data) return;
        if (data === "[DONE]") { done = true; return; }
        return modelOutput(() => {
          const d = object(JSON.parse(data));
          if (d.error) throw new InferError("INVALID_MODEL_OUTPUT", "Provider stream reported an error");
          const nextUsage = readUsage(d.usage); if (nextUsage) usage = nextUsage;
          list(d.choices, "choices"); if (!d.choices.length) return;
          const choice = object(d.choices[0]); const delta = object(choice.delta ?? {});
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) reason = choice.finish_reason;
          if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) { text(delta.reasoning_content, "reasoning_content", true); reasoningContent += delta.reasoning_content; }
          if (delta.tool_calls !== undefined) {
            list(delta.tool_calls, "delta.tool_calls");
            for (const raw of delta.tool_calls) {
              const t = object(raw); if (!Number.isSafeInteger(t.index) || (t.index as number) < 0) throw new InferError("INVALID_MODEL_OUTPUT", "Invalid tool call index");
              const c = calls.get(t.index as number) ?? { id: "", name: "", arguments: "" };
              if (t.id !== undefined) { text(t.id, "tool id"); c.id += t.id; }
              if (t.type !== undefined && t.type !== "function") throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported tool type");
              if (t.function !== undefined) { const f = object(t.function); if (f.name !== undefined) { text(f.name, "function name", true); c.name += f.name; } if (f.arguments !== undefined) { text(f.arguments, "arguments", true); c.arguments += f.arguments; } }
              calls.set(t.index as number, c);
            }
          }
          if (delta.content !== undefined && delta.content !== null) { text(delta.content, "delta.content", true); content += delta.content; return delta.content; }
          return;
        });
      }

      for await (const data of events) {
        const delta = consume(data); if (delta !== undefined) yield { type: "text_delta", delta };
        if (done) break;
      }
        if (!done) throw new InferError("INCOMPLETE_MODEL_OUTPUT", "Provider stream ended before [DONE]");
        const output = modelOutput((): SampleOutput => {
          const actionRequests = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => action({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
          return { message: { role: "assistant", content, ...(actionRequests.length && reasoningContent ? { metadata: { provider: "openai-compatible", reasoningContent } } : {}) }, finishReason: finish(reason), ...(usage ? { usage } : {}), ...(actionRequests.length ? { actionRequests } : {}) };
        });
        yield { type: "result", output };
  },
};
