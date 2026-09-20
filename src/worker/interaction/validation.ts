import type { ExternalResult, InteractionError, JsonValue, OutputReceipt } from "../../contracts/common.js";

const absolutePathInError = /(?:^|\s|\(|"|')(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/[^/\s])/;
const stackFrameInError = /(?:^|\s)at\s+(?:async\s+)?(?:[^()\s]+\s+\()?[^()\s]+\.[cm]?[jt]sx?:\d+(?::\d+)?\)?(?:\s|$)/i;

export function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}

export function jsonValue(value: unknown, name: string, seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error(`${name} must be JSON-serializable`);
  if (seen.has(value)) throw new Error(`${name} must not contain a cycle`);
  seen.add(value);
  for (const [key, item] of Object.entries(value)) jsonValue(item, `${name}.${key}`, seen);
  seen.delete(value);
}

export function interactionError(value: unknown): asserts value is InteractionError {
  if (!value || typeof value !== "object") throw new Error("Interaction error is required");
  const error = value as Record<string, unknown>;
  nonempty(error.code, "error.code"); nonempty(error.message, "error.message");
  if (error.code.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(error.code)) throw new Error("Invalid error code");
  if (error.message.length > 512
    || /[\r\n\x00-\x1f]|Bearer\s|sk-[A-Za-z0-9]/i.test(error.message)
    || absolutePathInError.test(error.message)
    || stackFrameInError.test(error.message)) throw new Error("Unsafe interaction error message");
  if (error.retryable !== undefined && typeof error.retryable !== "boolean") throw new Error("error.retryable must be boolean");
}

export function externalResult(value: unknown): asserts value is ExternalResult {
  if (!value || typeof value !== "object") throw new Error("External result is required");
  const result = value as Record<string, unknown>;
  nonempty(result.callId, "callId"); nonempty(result.source, "source");
  if (!["success", "failed", "cancelled", "timeout", "unknown"].includes(String(result.status))) throw new Error("Invalid external result status");
  if (result.status === "success") {
    if (result.content === undefined && result.structuredContent === undefined && result.references === undefined) throw new Error("Successful external result has no content");
  } else interactionError(result.error);
  for (const field of ["content", "structuredContent", "metadata"] as const) {
    if (result[field] !== undefined) jsonValue(result[field], field);
  }
  if (result.references !== undefined) {
    if (!Array.isArray(result.references)) throw new Error("references must be an array");
    for (const reference of result.references) {
      if (!reference || typeof reference !== "object") throw new Error("Invalid reference");
      nonempty((reference as Record<string, unknown>).uri, "reference.uri");
    }
  }
}

export function outputReceipt(value: unknown): asserts value is OutputReceipt {
  if (!value || typeof value !== "object") throw new Error("Output receipt is required");
  const receipt = value as Record<string, unknown>;
  nonempty(receipt.deliveryId, "deliveryId");
  if (!["accepted", "rejected", "unknown"].includes(String(receipt.status))) throw new Error("Invalid output status");
  if (receipt.status !== "accepted") interactionError(receipt.error);
  if (receipt.metadata !== undefined) jsonValue(receipt.metadata, "metadata");
}
