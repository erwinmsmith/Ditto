import { randomUUID } from "node:crypto";
import type { Message } from "../types.js";
import type { SampleOutput } from "../reasoning/sample/types.js";
import type { ProviderProtocol, ModelStreamEvent } from "./types.js";
import { InferError, object, text, list, number, modelOutput } from "../validation.js";
function parts(message: Message, callIds: ReadonlySet<unknown> = new Set()): unknown[] {
  if (message.role === "tool") {
    text(message.metadata?.name, "tool metadata.name");
    let result: unknown = message.content;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { /* Text tool results are valid. */ } }
    const response = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
    return [{ functionResponse: { name: message.metadata.name, response,
      ...(callIds.has(message.metadata.actionRequestId) ? { id: message.metadata.actionRequestId } : {}) } }];
  }
  if (message.metadata?.provider === "gemini" && Array.isArray(message.metadata.parts)) return message.metadata.parts;
  const result: unknown[] = typeof message.content === "string" ? (message.content ? [{ text: message.content }] : []) : [...message.content];
  for (const raw of message.metadata?.actionRequests as unknown[] ?? []) {
    const call = object(raw); result.push({ functionCall: { name: call.name, args: call.arguments } });
  }
  return result;
}
function parse(raw: unknown): SampleOutput {
  return modelOutput(() => {
    const data = object(raw);
    if (!Array.isArray(data.candidates) || !data.candidates.length) throw new InferError("MODEL_ERROR", "Gemini returned no candidate");
    const candidate = object(data.candidates[0]); const content = object(candidate.content ?? { parts: [] }); list(content.parts, "parts");
    const nativeParts = content.parts.map(p => object(p));
    const calls = nativeParts.filter(p => p.functionCall).map(p => {
      const c = object(p.functionCall); text(c.name, "functionCall.name");
      const id = typeof c.id === "string" && c.id ? c.id : randomUUID();
      return { id, name: c.name, arguments: object(c.args ?? {}) };
    });
    const reason = candidate.finishReason;
    const finishReason = reason === "STOP" ? (calls.length ? "action_request" : "stop") : reason === "MAX_TOKENS" ? "length"
      : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "OTHER"].includes(String(reason)) ? "error" : undefined;
    if (!finishReason) throw new InferError("INVALID_MODEL_OUTPUT", "Unsupported or missing Gemini finish reason");
    const textParts = nativeParts.filter(p => p.text !== undefined && !p.thought).map(p => { text(p.text, "text", true); return p.text; });
    const u = data.usageMetadata ? object(data.usageMetadata) : undefined;
    if (u) for (const key of ["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount", "cachedContentTokenCount"]) {
      if (u[key] !== undefined) number(u[key], key, 0, Number.MAX_SAFE_INTEGER, true);
    }
    return { message: { role: "assistant", content: textParts.join(""), metadata: { provider: "gemini", parts: nativeParts } }, finishReason,
      ...(calls.length ? { actionRequests: calls } : {}), ...(u ? { usage: {
        ...(u.promptTokenCount !== undefined ? { inputTokens: u.promptTokenCount as number } : {}),
        ...(u.candidatesTokenCount !== undefined ? { outputTokens: (u.candidatesTokenCount as number) + Number(u.thoughtsTokenCount ?? 0) } : {}),
        ...(u.totalTokenCount !== undefined ? { totalTokens: Number(u.totalTokenCount) } : {}),
        ...(u.thoughtsTokenCount !== undefined ? { reasoningTokens: Number(u.thoughtsTokenCount) } : {}),
        ...(u.cachedContentTokenCount !== undefined ? { cachedInputTokens: Number(u.cachedContentTokenCount) } : {}),
      } } : {}) };
  });
}
export const gemini: ProviderProtocol = {
  path: (model, streaming) => `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`,
  headers: key => key ? { "x-goog-api-key": key } : {},
  body(input) {
    const callIds = new Set(input.messages.filter(m => m.role === "assistant" && m.metadata?.provider === "gemini")
      .flatMap(m => (m.metadata!.parts as Record<string, unknown>[]).map(p => (p.functionCall as Record<string, unknown> | undefined)?.id)).filter(Boolean));
    const g = input.generation; const contents: { role: string; parts: unknown[] }[] = [];
    for (const message of input.messages.filter(m => m.role !== "system")) {
      const role = message.role === "assistant" ? "model" : "user"; const previous = contents.at(-1);
      if (previous?.role === role) previous.parts.push(...parts(message, callIds)); else contents.push({ role, parts: parts(message, callIds) });
    }
    const system = input.messages.filter(m => m.role === "system").flatMap(m => parts(m));
    return { ...input.model.providerOptions, contents, systemInstruction: system.length ? { parts: system } : undefined,
      tools: input.actions?.length ? [{ functionDeclarations: input.actions.map(a => ({ name: a.name, description: a.description ?? "", parametersJsonSchema: a.inputSchema })) }] : undefined,
      generationConfig: { ...object(input.model.providerOptions?.generationConfig ?? {}), candidateCount: 1,
        ...(g?.maxTokens !== undefined ? { maxOutputTokens: g.maxTokens } : {}), ...(g?.temperature !== undefined ? { temperature: g.temperature } : {}),
        ...(g?.topP !== undefined ? { topP: g.topP } : {}), ...(g?.topK !== undefined ? { topK: g.topK } : {}),
        ...(g?.stop !== undefined ? { stopSequences: g.stop } : {}), ...(g?.seed !== undefined ? { seed: g.seed } : {}) } };
  },
  parse,
  async *stream(events): AsyncIterable<ModelStreamEvent> {
    const content: unknown[] = []; let reason: unknown; let usageMetadata: unknown;
    for await (const raw of events) {
      const data = modelOutput(() => object(JSON.parse(raw)));
      if (data.error) throw new InferError("MODEL_ERROR", "Gemini stream reported an error");
      if (data.usageMetadata) usageMetadata = data.usageMetadata;
      if (!Array.isArray(data.candidates) || !data.candidates.length) {
        if (data.promptFeedback) throw new InferError("MODEL_ERROR", "Gemini blocked the prompt");
        continue;
      }
      const candidate = object(data.candidates[0]); if (candidate.finishReason) reason = candidate.finishReason;
      const next = object(candidate.content ?? { parts: [] }); list(next.parts, "parts");
      for (const rawPart of next.parts) { const p = object(rawPart); content.push(p);
        if (p.text !== undefined) { text(p.text, "text", true); yield { type: p.thought ? "reasoning_delta" : "text_delta", delta: p.text }; }
        if (p.functionCall) { const call = object(p.functionCall); text(call.name, "functionCall.name"); yield { type: "action_delta", index: content.length - 1, ...(typeof call.id === "string" ? { id: call.id } : {}), name: call.name, delta: JSON.stringify(object(call.args ?? {})) }; }
      }
    }
    if (!reason) throw new InferError("INCOMPLETE_MODEL_OUTPUT", "Gemini stream ended before finishReason");
    yield { type: "result", output: parse({ candidates: [{ content: { parts: content }, finishReason: reason }], usageMetadata }) };
  },
};
