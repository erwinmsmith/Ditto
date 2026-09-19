import { object, check, text } from "../../validation.js";
import { cacheKey } from "../schema.js";
import type { CacheInvalidateInput } from "./types.js";
export function validateInvalidate(input: unknown): asserts input is CacheInvalidateInput {
  const s = object(object(input).selector, "selector");
  check(["key", "tag", "namespace"].includes(String(s.type)), "Invalid cache selector");
  if (s.type === "key") cacheKey(s.key);
  else if (s.type === "tag") text(s.tag, "tag");
  else text(s.namespace, "namespace", true);
}
