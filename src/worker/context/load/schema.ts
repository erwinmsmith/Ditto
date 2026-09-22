import type { ContextLoadInput } from "./types.js";
import { check, contextSource, object } from "../validation.js";

export function validateLoad(value: unknown): asserts value is ContextLoadInput {
  const input = object(value, "input");
  check(input.resolveReferences === undefined || typeof input.resolveReferences === "boolean", "resolveReferences must be boolean");
  check(Array.isArray(input.sources), "sources must be an array");
  input.sources.forEach((source, index) => contextSource(source, `sources[${index}]`));
}
