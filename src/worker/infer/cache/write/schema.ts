import { object, check, number, list, text } from "../../validation.js";
import { cacheKey } from "../schema.js";
import type { CacheWriteInput } from "./types.js";
export function validateWrite(input: unknown): asserts input is CacheWriteInput {
  const v = object(input); cacheKey(v.key); check(Object.hasOwn(v, "value"), "value is required");
  if (v.ttlMs !== undefined) number(v.ttlMs, "ttlMs", 0, Number.MAX_SAFE_INTEGER, true);
  if (v.tags !== undefined) { list(v.tags, "tags"); v.tags.forEach(t => text(t, "tag")); }
}
