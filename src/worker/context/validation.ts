import type {
  Context, ContextIngress, ContextItem, ContextSource, JsonObject,
  Message, MessageContent, Reference,
} from "../../contracts/common.js";
import type { ContextPolicy } from "./types.js";

export class ContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export function check(value: unknown, message: string, code = "INVALID_INPUT"): asserts value {
  if (!value) throw new ContextError(code, message);
}

export function object(value: unknown, name = "value"): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown, name: string): asserts value is string {
  check(typeof value === "string" && value.length > 0, `${name} must be a nonempty string`);
}

export function nonnegativeInteger(value: unknown, name: string, max = 1_000_000): asserts value is number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max,
    `${name} must be an integer in 0..${max}`);
}

function json(value: unknown, name: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    check(Number.isFinite(value), `${name} contains a non-finite number`);
    return;
  }
  check(typeof value === "object", `${name} must be JSON-serializable`);
  check(!seen.has(value), `${name} cannot contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => json(entry, `${name}[${index}]`, seen));
  else for (const [key, entry] of Object.entries(value)) json(entry, `${name}.${key}`, seen);
  seen.delete(value);
}

export function jsonObject(value: unknown, name: string): asserts value is JsonObject {
  object(value, name);
  json(value, name);
}

export function messageContent(value: unknown, name = "content"): asserts value is MessageContent {
  check(value !== undefined, `${name} is required`);
  json(value, name);
}

export function reference(value: unknown, name = "reference"): asserts value is Reference {
  const candidate = object(value, name);
  nonempty(candidate.uri, `${name}.uri`);
  if (candidate.mediaType !== undefined) nonempty(candidate.mediaType, `${name}.mediaType`);
  if (candidate.digest !== undefined) nonempty(candidate.digest, `${name}.digest`);
}

export function message(value: unknown, name = "message"): asserts value is Message {
  const candidate = object(value, name);
  check(["system", "user", "assistant", "tool"].includes(candidate.role as string), `${name}.role is invalid`);
  messageContent(candidate.content, `${name}.content`);
  if (candidate.name !== undefined) nonempty(candidate.name, `${name}.name`);
}

export function contextItem(value: unknown, name = "item"): asserts value is ContextItem {
  const candidate = object(value, name);
  nonempty(candidate.id, `${name}.id`);
  messageContent(candidate.content, `${name}.content`);
  if (candidate.source !== undefined) reference(candidate.source, `${name}.source`);
  if (candidate.metadata !== undefined) jsonObject(candidate.metadata, `${name}.metadata`);
}

export function context(value: unknown, name = "context"): asserts value is Context {
  const candidate = object(value, name);
  check(Array.isArray(candidate.items), `${name}.items must be an array`);
  const ids = new Set<string>();
  for (const [index, item] of candidate.items.entries()) {
    contextItem(item, `${name}.items[${index}]`);
    check(!ids.has(item.id), `${name} contains duplicate item id: ${item.id}`);
    ids.add(item.id);
  }
}

export function contextSource(value: unknown, name = "source"): asserts value is ContextSource {
  const candidate = object(value, name);
  if ("id" in candidate) contextItem(value, name);
  else if ("role" in candidate) message(value, name);
  else reference(value, name);
}

export function ingress(value: unknown, name = "ingress"): asserts value is ContextIngress {
  const candidate = object(value, name);
  nonempty(candidate.id, `${name}.id`);
  nonempty(candidate.sourceNode, `${name}.sourceNode`);
  check(/^[^.\s]+(?:\.[^.\s]+)+$/.test(candidate.sourceNode), `${name}.sourceNode must be a qualified Node ID`);
  messageContent(candidate.content, `${name}.content`);
  if (candidate.reference !== undefined) reference(candidate.reference, `${name}.reference`);
  if (candidate.metadata !== undefined) jsonObject(candidate.metadata, `${name}.metadata`);
}

export function validatePolicy(policy: ContextPolicy): void {
  nonnegativeInteger(policy.maxInlineBytes, "policy.maxInlineBytes");
  check(policy.maxInlineBytes > 0, "policy.maxInlineBytes must be positive");
  nonnegativeInteger(policy.maxItems, "policy.maxItems");
  check(policy.maxItems > 0, "policy.maxItems must be positive");
  if (policy.maxTokens !== undefined) {
    nonnegativeInteger(policy.maxTokens, "policy.maxTokens");
    check(policy.maxTokens > 0, "policy.maxTokens must be positive");
  }
  check(["replace", "keep-first", "reject"].includes(policy.duplicate), "policy.duplicate is invalid");
  check(["ignore", "reject"].includes(policy.missingRemoval), "policy.missingRemoval is invalid");
}

export function inlineBytes(content: MessageContent): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
