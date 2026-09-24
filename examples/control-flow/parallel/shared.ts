import { graph, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import type { ModelConfig } from "@codesoul-co/ditto/worker/infer";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import { identifier, object, orderRecord, toJsonObject, type SavedOrder } from "../../_shared/tools/order-files.ts";

export type Runner = Pick<DittoRuntime, "run">;
export interface Source { readonly id: string; readonly path: string; readonly description: string }
export interface BatchInput { readonly id: string; readonly sources: readonly Source[]; readonly model: ModelConfig }
export interface ExecutionOptions { readonly concurrency?: number; readonly signal?: AbortSignal }
export class OrderTaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function validateBatch(input: BatchInput): void {
  identifier(input.id);
  if (!Array.isArray(input.sources) || input.sources.length > 8) throw new Error("A batch supports at most eight source tasks");
  const seen = new Set<string>();
  for (const source of input.sources) {
    identifier(source.id);
    if (seen.has(source.id) || !source.path.trim() || !source.description.trim()) throw new Error("Sources require unique IDs and nonempty paths and descriptions");
    seen.add(source.id);
  }
}
export function validateOptions(options: ExecutionOptions): void {
  if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)) throw new Error("Concurrency must be a positive integer");
  options.signal?.throwIfAborted();
}
export function toolData(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (result.status !== "success") {
    const error = result.error ? object(result.error) : {};
    throw new OrderTaskError(typeof error.code === "string" ? error.code : "TOOL_FAILED", typeof error.message === "string" ? error.message : "Order tool did not complete");
  }
  return object(result.structuredContent);
}
export function modelJson(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (result.status !== "success") throw new OrderTaskError("MODEL_FAILED", "Order model did not complete");
  const output = object(result.output);
  const message = object(output.message);
  if (output.finishReason !== "stop" || message.role !== "assistant" || typeof message.content !== "string") throw new OrderTaskError("INVALID_MODEL_OUTPUT", "Order model did not complete with JSON text");
  try { return object(JSON.parse(message.content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""))); }
  catch { throw new OrderTaskError("INVALID_MODEL_OUTPUT", "Order model returned invalid JSON"); }
}
export function modelOrder(value: unknown) {
  try { return orderRecord(modelJson(value)); }
  catch (error) { if (error instanceof OrderTaskError) throw error; throw new OrderTaskError("INVALID_MODEL_OUTPUT", "Order model returned invalid fields"); }
}
export function savedOrder(value: unknown): SavedOrder {
  const data = toolData(value);
  const record = orderRecord(data);
  if (typeof data.sourceId !== "string" || typeof data.sourceSha256 !== "string" || data.totalCents !== record.quantity * record.unitPriceCents) throw new Error("Invalid saved order");
  return { sourceId: data.sourceId, sourceSha256: data.sourceSha256, ...record, totalCents: data.totalCents };
}
export function sourceFor(input: BatchInput, id: string): Source {
  const source = input.sources.find(item => item.id === id);
  if (!source) throw new Error("Planned source not found");
  return source;
}
export function sampleInput(model: ModelConfig, loaded: unknown) {
  const source = toolData(loaded);
  if (typeof source.text !== "string" || !source.text.trim()) throw new OrderTaskError("INVALID_SOURCE", "Order source contains no text");
  return { model, messages: [
    { role: "system" as const, content: 'Extract the order in the supplied source. Return ONLY JSON {"code":string,"quantity":positive integer,"unitPriceCents":nonnegative integer}. Prices are in cents. Preserve code exactly. Never invent missing fields.' },
    { role: "user" as const, content: source.text },
  ] };
}
export function saveInput(batchId: string, sourceId: string, loaded: unknown, sampled: unknown) {
  const source = toolData(loaded);
  return { call: { id: `${batchId}:${sourceId}:save`, name: "save_order", arguments: toJsonObject({
    batchId, sourceId, sourceSha256: source.sourceSha256, record: modelOrder(sampled),
  }) } };
}
export const orderGraph = graph<{ batchId: string; source: Source; model: ModelConfig }>("one-order")
  .node("loaded", "INTERACTION.ACT.TOOL", [], input => ({ call: { id: `${input.batchId}:${input.source.id}:read`, name: "read_order_source", arguments: { sourceId: input.source.id, path: input.source.path } } }))
  .node("sampled", "INFER.REASONING.SAMPLE", ["loaded"], (input, { loaded }) => sampleInput(input.model, loaded))
  .node("saved", "INTERACTION.ACT.TOOL", ["loaded", "sampled"], (input, { loaded, sampled }) => saveInput(input.batchId, input.source.id, loaded, sampled));

export function deliveryInput(id: string, report: unknown) {
  return { deliveryId: id, message: { role: "assistant" as const, content: toolData(report) as JsonObject } };
}
export function accepted(receipt: { status: string }): void {
  if (receipt.status !== "accepted") throw new OrderTaskError("DELIVERY_FAILED", "Order report delivery was not accepted");
}
