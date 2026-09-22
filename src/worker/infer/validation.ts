import type { Message, Usage } from "./types.js";

export class InferError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "InferError"; }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InferError("INVALID_INPUT", message);
}
export function object(value: unknown, name = "value"): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, empty = false): asserts value is string {
  check(typeof value === "string" && (empty || value.trim().length > 0), `${name} must be a string${empty ? "" : " (nonempty)"}`);
}
export function number(value: unknown, name: string, min = -Infinity, max = Infinity, integer = false): asserts value is number {
  check(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)), `${name} is out of range`);
}
export function list(value: unknown, name: string): asserts value is unknown[] { check(Array.isArray(value), `${name} must be an array`); }
export function message(value: unknown): asserts value is Message {
  const v = object(value, "message");
  check(["system", "user", "assistant", "tool"].includes(String(v.role)), "Invalid message role");
  check(typeof v.content === "string" || Array.isArray(v.content), "Invalid message content");
  if (v.metadata !== undefined) object(v.metadata, "message.metadata");
}
export function common(value: unknown): Record<string, unknown> {
  const v = object(value, "input");
  const m = object(v.model, "model"); text(m.model, "model.model");
  if (m.provider !== undefined) text(m.provider, "model.provider");
  if (m.endpoint !== undefined) text(m.endpoint, "model.endpoint");
  if (m.providerOptions !== undefined) object(m.providerOptions, "model.providerOptions");
  if (v.metadata !== undefined) object(v.metadata, "metadata");
  if (v.generation !== undefined) {
    const g = object(v.generation, "generation");
    for (const key of ["temperature", "topP", "topK", "maxTokens", "seed"]) {
      if (g[key] === undefined) continue;
      number(g[key], `generation.${key}`, key === "seed" ? -Number.MAX_SAFE_INTEGER : key === "maxTokens" || key === "topK" ? 1 : 0,
        key === "temperature" ? 2 : key === "topP" ? 1 : Number.MAX_SAFE_INTEGER, ["topK", "maxTokens", "seed"].includes(key));
    }
    if (g.stop !== undefined) { list(g.stop, "generation.stop"); g.stop.forEach(s => text(s, "stop")); }
  }
  for (const key of ["context", "memory"]) {
    if (v[key] === undefined) continue;
    list(v[key], key);
    for (const item of v[key]) {
      const x = object(item, key); check(Object.hasOwn(x, "content"), `${key}.content is required`);
      if (key === "memory" || x.id !== undefined) text(x.id, `${key}.id`);
      if (x.score !== undefined) number(x.score, `${key}.score`);
      if (x.timestamp !== undefined) number(x.timestamp, "timestamp", 0);
      if (x.source !== undefined) text(x.source, "source");
    }
  }
  return v;
}
export function messagesAndActions(v: Record<string, unknown>): void {
  list(v.messages, "messages"); check(v.messages.length > 0, "messages must not be empty"); v.messages.forEach(message);
  if (v.actions !== undefined) {
    list(v.actions, "actions"); const names = new Set<string>();
    for (const raw of v.actions) {
      const a = object(raw, "action"); text(a.name, "action.name");
      check(!names.has(a.name), "Duplicate action name"); names.add(a.name);
      object(a.inputSchema, "action.inputSchema");
      if (a.description !== undefined) text(a.description, "action.description", true);
      if (a.target !== undefined) {
        const target = object(a.target, "action.target");
        if (target.kind === "tool") {
          if (target.toolName !== undefined) text(target.toolName, "action.target.toolName");
        } else if (target.kind === "mcp") {
          text(target.server, "action.target.server"); text(target.toolName, "action.target.toolName");
        } else if (target.kind === "node") nodeName(target.node);
        else check(false, "Invalid action target kind");
      }
    }
  }
}
export function nodeName(value: unknown): asserts value is string { text(value, "action.target.node"); check(/^[^.\s]+(?:\.[^.\s]+)+$/.test(value), "Invalid action target node"); }
export function steps(value: unknown): void {
  list(value, "trajectory");
  for (const raw of value) {
    const s = object(raw, "step"); text(s.id, "step.id"); number(s.index, "step.index", 0, Number.MAX_SAFE_INTEGER, true);
    check(["plan", "model", "decision", "action_request", "observation", "reflection", "final"].includes(String(s.type)), "Invalid step type");
    if (s.message !== undefined) message(s.message);
  }
}
export function usage(value: unknown): asserts value is Usage {
  const v = object(value, "usage");
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"]) {
    if (v[key] !== undefined) number(v[key], `usage.${key}`, 0, Number.MAX_SAFE_INTEGER, true);
  }
}
export function parseOutput(content: Message["content"]): Record<string, unknown> {
  try {
    check(typeof content === "string", "Structured model output must be text");
    return object(JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")), "model output");
  } catch { throw new InferError("INVALID_MODEL_OUTPUT", "Model must return a valid JSON object"); }
}
export function modelOutput<T>(validate: () => T): T {
  try { return validate(); }
  catch (error) { throw new InferError("INVALID_MODEL_OUTPUT", error instanceof Error ? error.message : "Invalid model output"); }
}
export function errorInfo(error: unknown): { code: string; message: string } {
  return { code: error instanceof InferError ? error.code : error instanceof Error && error.name === "TimeoutError" ? "TIMEOUT" : error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "EXECUTION_FAILED",
    message: error instanceof Error ? error.message : "Execution failed" };
}
/** Race even adapters that ignore AbortSignal; callers must still cooperate to stop their I/O. */
export async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
export function addUsage(total: Usage, next?: Usage): void {
  if (!next) return;
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens"] as const) {
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
  }
  const tokens = next.totalTokens ?? (next.inputTokens !== undefined || next.outputTokens !== undefined ? (next.inputTokens ?? 0) + (next.outputTokens ?? 0) : undefined);
  if (tokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + tokens;
}
