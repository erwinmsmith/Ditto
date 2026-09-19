import type { Message, Usage } from "../types.js";
import type { SampleOutput } from "../reasoning/sample/types.js";
import type { ProviderProtocol, ModelStreamEvent } from "./types.js";
import { InferError, object, text, list, number, modelOutput } from "../validation.js";
function blocks(message: Message): unknown[] {
  if (message.role === "tool") {
    text(message.metadata?.actionRequestId, "actionRequestId");
    return [{ type: "tool_result", tool_use_id: message.metadata.actionRequestId, content: message.content }];
  }
  if (message.metadata?.provider === "anthropic" && Array.isArray(message.metadata.contentBlocks)) return message.metadata.contentBlocks;
  const content: unknown[] = typeof message.content === "string" ? (message.content ? [{ type: "text", text: message.content }] : []) : [...message.content];
  for (const raw of message.metadata?.actionRequests as unknown[] ?? []) {
    const call = object(raw); content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
  }
  return content;
}
function usage(raw: unknown): Usage | undefined {
  if (raw == null) return;
  const u = object(raw);
  for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]) {
    if (u[key] !== undefined) number(u[key], key, 0, Number.MAX_SAFE_INTEGER, true);
  }
  const inputTokens = u.input_tokens === undefined ? undefined : (u.input_tokens as number) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0);
  const outputTokens = u.output_tokens as number | undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    ...(u.cache_read_input_tokens !== undefined ? { cachedInputTokens: u.cache_read_input_tokens as number } : {}) };
}
function parse(raw: unknown): SampleOutput {
  return modelOutput(() => {
    const data = object(raw); list(data.content, "content");
    const content = data.content.map(block => object(block));
    const calls = content.filter(b => b.type === "tool_use").map(b => {
      text(b.id, "tool_use.id"); text(b.name, "tool_use.name"); return { id: b.id, name: b.name, arguments: object(b.input) };
    });
    const reason = data.stop_reason;
    const finishReason = reason === "end_turn" || reason === "stop_sequence" ? "stop" : reason === "max_tokens" ? "length" : reason === "tool_use" ? "action_request" : reason === "refusal" ? "error" : undefined;
    if (!finishReason) throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported or missing Anthropic stop reason");
    const parts = content.filter(b => b.type === "text").map(b => { text(b.text, "text", true); return b.text; });
    const tokens = usage(data.usage);
    return { message: { role: "assistant", content: parts.join(""), metadata: { provider: "anthropic", contentBlocks: content } }, finishReason,
      ...(calls.length ? { actionRequests: calls } : {}), ...(tokens ? { usage: tokens } : {}) };
  });
}
export const anthropic: ProviderProtocol = {
  path: () => "/messages",
  headers: key => ({ "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }),
  body(input, streaming) {
    if (input.generation?.seed !== undefined) throw new InferError("INVALID_INPUT", "Anthropic does not support generation.seed");
    const messages: { role: string; content: unknown[] }[] = [];
    for (const message of input.messages.filter(m => m.role !== "system")) {
      const role = message.role === "assistant" ? "assistant" : "user";
      const previous = messages.at(-1); const content = blocks(message);
      if (previous?.role === role) previous.content.push(...content); else messages.push({ role, content });
    }
    const g = input.generation;
    return { ...input.model.providerOptions, model: input.model.model, stream: streaming, messages,
      system: input.messages.filter(m => m.role === "system").flatMap(blocks),
      tools: input.actions?.length ? input.actions.map(a => ({ name: a.name, description: a.description ?? "", input_schema: a.inputSchema })) : undefined,
      max_tokens: g?.maxTokens ?? input.model.providerOptions?.max_tokens ?? 4096,
      ...(g?.temperature !== undefined ? { temperature: g.temperature } : {}),
      ...(g?.topP !== undefined ? { top_p: g.topP } : {}), ...(g?.topK !== undefined ? { top_k: g.topK } : {}),
      ...(g?.stop !== undefined ? { stop_sequences: g.stop } : {}) };
  },
  parse,
  async *stream(events): AsyncIterable<ModelStreamEvent> {
    const content: Record<string, unknown>[] = []; const json = new Map<number, string>();
    let active: number | undefined; let started = false; let ended = false; let reason: unknown; let tokens: Record<string, unknown> = {};
    for await (const raw of events) {
      const e = modelOutput(() => object(JSON.parse(raw)));
      if (e.type === "error") throw new InferError("MODEL_ERROR", "Anthropic stream reported an error");
      if (e.type === "message_start") { const m = object(e.message); tokens = object(m.usage ?? {}); started = true; }
      else if (e.type === "content_block_start") {
        if (!started || active !== undefined || !Number.isSafeInteger(e.index) || e.index !== content.length) throw new InferError("INVALID_MODEL_OUTPUT", "Invalid content block index");
        active = e.index as number; content.push({ ...object(e.content_block) });
      } else if (e.type === "content_block_delta") {
        const b = content[e.index as number]; if (!b || active !== e.index) throw new InferError("INVALID_MODEL_OUTPUT", "Missing content block");
        const d = object(e.delta);
        if (d.type === "text_delta") { text(d.text, "text", true); b.text = String(b.text ?? "") + d.text; yield { type: "text_delta", delta: d.text }; }
        else if (d.type === "input_json_delta") { text(d.partial_json, "partial_json", true); json.set(e.index as number, (json.get(e.index as number) ?? "") + d.partial_json); }
        else if (d.type === "thinking_delta") { text(d.thinking, "thinking", true); b.thinking = String(b.thinking ?? "") + d.thinking; }
        else if (d.type === "signature_delta") { text(d.signature, "signature", true); b.signature = String(b.signature ?? "") + d.signature; }
      } else if (e.type === "content_block_stop") {
        if (active !== e.index) throw new InferError("INVALID_MODEL_OUTPUT", "Invalid content block stop");
        const value = json.get(e.index as number);
        if (value !== undefined) { const b = content[e.index as number]; if (!b || active !== e.index) throw new InferError("INVALID_MODEL_OUTPUT", "Missing tool block"); b.input = modelOutput(() => object(JSON.parse(value))); }
        active = undefined;
      } else if (e.type === "message_delta") { reason = object(e.delta).stop_reason; tokens = { ...tokens, ...object(e.usage ?? {}) }; }
      else if (e.type === "message_stop") { ended = true; break; }
    }
    if (!started || !ended || active !== undefined) throw new InferError("INCOMPLETE_MODEL_OUTPUT", "Anthropic stream ended before message_stop");
    yield { type: "result", output: parse({ content, stop_reason: reason, usage: tokens }) };
  },
};
