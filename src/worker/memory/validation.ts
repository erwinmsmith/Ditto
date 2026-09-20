import type { MemoryItem } from "./types.js";
export class MemoryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MemoryError"; }
}
export function check(value: unknown, message: string): asserts value { if (!value) throw new MemoryError("INVALID_INPUT", message); }
export function object(value: unknown, name = "value"): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string): asserts value is string { check(typeof value === "string" && value.length > 0, `${name} must be a nonempty string`); }
export function integer(value: unknown, name: string, max = 10000): asserts value is number { check(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max, `${name} must be an integer in 1..${max}`); }
function strings(value: unknown, name: string): asserts value is readonly string[] { check(Array.isArray(value), `${name} must be an array`); value.forEach(v => text(v, name)); }
export function item(value: unknown): asserts value is MemoryItem {
  const v = object(value, "memory"); text(v.id, "id"); check(Object.hasOwn(v, "content"), "content is required");
  if (v.key !== undefined) text(v.key, "key"); if (v.metadata !== undefined) object(v.metadata, "metadata");
}
export function validateInput(operation: string, value: unknown): void {
  const v = object(value, "input");
  if (operation === "get") {
    check(v.ids !== undefined || v.keys !== undefined, "GET requires ids or keys");
    if (v.ids !== undefined) strings(v.ids, "ids"); if (v.keys !== undefined) strings(v.keys, "keys");
  } else if (operation === "delete") strings(v.ids, "ids");
  else if (operation === "write" || operation === "update") {
    check(Array.isArray(v.memories), "memories must be an array"); const ids = new Set<string>();
    for (const raw of v.memories) {
      const m = object(raw, "memory");
      if (operation === "write") { check(Object.hasOwn(m, "content"), "content is required"); if (m.key !== undefined) text(m.key, "key"); }
      else { text(m.id, "id"); check(!ids.has(m.id), "Duplicate update id"); ids.add(m.id); check(Object.hasOwn(m, "content") || m.metadata !== undefined, "UPDATE requires content or metadata"); check(!Object.hasOwn(m, "key"), "UPDATE cannot change key"); }
      if (m.metadata !== undefined) object(m.metadata, "metadata");
    }
  } else if (operation === "query" || operation === "search") {
    if (v.filter !== undefined) object(v.filter, "filter"); if (v.limit !== undefined) integer(v.limit, "limit");
    if (operation === "search") {
      check(Object.hasOwn(v, "query"), "query is required"); if (v.strategy !== undefined) text(v.strategy, "strategy"); if (v.options !== undefined) object(v.options, "options");
    } else {
      if (v.cursor !== undefined) text(v.cursor, "cursor");
      if (v.orderBy !== undefined) { check(Array.isArray(v.orderBy), "orderBy must be an array"); for (const raw of v.orderBy) { const o = object(raw, "orderBy"); text(o.field, "orderBy.field"); check(o.direction === undefined || o.direction === "asc" || o.direction === "desc", "Invalid order direction"); } }
    }
  } else throw new MemoryError("UNKNOWN_NODE", "Unknown MEMORY operation");
}
export function validateOutput(operation: string, output: unknown, input?: unknown): void {
  try {
    const request = input === undefined ? undefined : object(input);
    if (operation === "delete") {
      const deleted = object(output).deleted; strings(deleted, "deleted");
      check(new Set(deleted).size === deleted.length, "Duplicate deleted id");
      if (request) { const ids = new Set(request.ids as string[]); check(deleted.every(id => ids.has(id)), "Unexpected deleted id"); }
      return;
    }
    const values = operation === "query" ? object(output).items : output;
    if (operation === "query" && object(output).nextCursor !== undefined) text(object(output).nextCursor, "nextCursor");
    check(Array.isArray(values), "Output must contain an array"); const ids = new Set<string>();
    for (const value of values) {
      const memory = operation === "search" ? object(value).memory : value; item(memory);
      check(!ids.has(memory.id), "Duplicate output memory id"); ids.add(memory.id);
      if (operation === "search") { const hit = object(value); if (hit.score !== undefined) check(typeof hit.score === "number" && Number.isFinite(hit.score), "Invalid search score"); if (hit.metadata !== undefined) object(hit.metadata); }
    }
    if (request) {
      if (operation === "write" || operation === "update") {
        const entries = request.memories as Record<string, unknown>[];
        check(values.length === entries.length, "Incomplete mutation result");
        if (operation === "update") check(entries.every(entry => ids.has(entry.id as string)), "Unexpected update id");
      }
      if ((operation === "query" || operation === "search") && request.limit !== undefined) {
        check(values.length <= (request.limit as number), "Result exceeds limit");
      }
    }
  } catch { throw new MemoryError("INVALID_BACKEND_OUTPUT", "MEMORY backend returned an invalid result"); }
}
