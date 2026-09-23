import { createHash } from "node:crypto";
import type {
  Context, ContextItem, ContextSource, JsonObject, JsonValue,
  Message, MessageContent, Reference,
} from "../../contracts/common.js";
import type {
  ContextExecution, ContextPolicy, ContextServices,
} from "./types.js";
import { ContextError, check, inlineBytes, validatePolicy } from "./validation.js";

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  maxInlineBytes: 64 * 1024,
  maxItems: 256,
  duplicate: "replace",
  missingRemoval: "ignore",
});

export function createContextExecution(
  policy: Partial<ContextPolicy> = {},
  services: ContextServices = {},
): ContextExecution {
  const resolved: ContextPolicy = Object.freeze({
    maxInlineBytes: policy.maxInlineBytes ?? DEFAULT_CONTEXT_POLICY.maxInlineBytes,
    maxItems: policy.maxItems ?? DEFAULT_CONTEXT_POLICY.maxItems,
    ...(policy.maxTokens === undefined ? {} : { maxTokens: policy.maxTokens }),
    duplicate: policy.duplicate ?? DEFAULT_CONTEXT_POLICY.duplicate,
    missingRemoval: policy.missingRemoval ?? DEFAULT_CONTEXT_POLICY.missingRemoval,
  });
  validatePolicy(resolved);
  return Object.freeze({ policy: resolved, services: Object.freeze({ ...services }) });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function stableContextId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function clone<T>(value: T): T { return structuredClone(value); }

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotItem(item: ContextItem): ContextItem {
  return freezeDeep(clone(item));
}

export function snapshotContext(items: readonly ContextItem[]): Context {
  return Object.freeze({ items: Object.freeze(items.map(snapshotItem)) });
}

function messageMetadata(message: Message): JsonObject {
  return Object.freeze({
    sourceType: "message",
    role: message.role,
    ...(message.name === undefined ? {} : { name: message.name }),
  });
}

export function normalizeSource(source: ContextSource, execution: ContextExecution): ContextItem {
  if ("id" in source) return checkedItem(source, execution);
  if ("role" in source) {
    const message = clone(source);
    return checkedItem({
      id: stableContextId("message", message),
      content: message.content,
      metadata: messageMetadata(message),
    }, execution);
  }
  const reference: Reference = clone(source);
  return checkedItem({
    id: stableContextId("reference", reference),
    content: [{ type: "reference", reference }],
    source: reference,
    metadata: { sourceType: "reference" },
  }, execution);
}

export function checkedItem(item: ContextItem, execution: ContextExecution): ContextItem {
  const bytes = inlineBytes(item.content);
  const referenced = item.source !== undefined
    || (Array.isArray(item.content) && item.content.some(part =>
      part !== null && typeof part === "object" && "type" in part && part.type === "reference"));
  check(bytes <= execution.policy.maxInlineBytes || referenced,
    `Context item ${item.id} exceeds the inline byte limit`, "INLINE_LIMIT_EXCEEDED");
  return snapshotItem(item);
}

export function putItem(
  items: Map<string, ContextItem>,
  item: ContextItem,
  policy: ContextPolicy,
): void {
  if (!items.has(item.id)) {
    items.set(item.id, item);
    return;
  }
  if (policy.duplicate === "keep-first") return;
  if (policy.duplicate === "reject") throw new ContextError("DUPLICATE_ITEM", `Duplicate Context item: ${item.id}`);
  // Map.set replaces the value without moving the original insertion position.
  items.set(item.id, item);
}

export async function estimateTokens(content: MessageContent, execution: ContextExecution): Promise<number> {
  execution.signal?.throwIfAborted();
  const supplied = await execution.services.tokenEstimator?.estimate(content, execution);
  execution.signal?.throwIfAborted();
  const estimate = supplied ?? Math.ceil(new TextEncoder().encode(JSON.stringify(content)).byteLength / 4);
  check(Number.isSafeInteger(estimate) && estimate >= 0, "Token estimator returned an invalid value", "INVALID_PROVIDER_OUTPUT");
  return estimate;
}

export function numericMetadata(item: ContextItem, key: string): number {
  const value = item.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function booleanMetadata(item: ContextItem, key: string): boolean {
  return item.metadata?.[key] === true;
}

export function textContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) return String(part.text);
    return canonical(part);
  }).join(" ");
  return canonical(content as JsonValue);
}
