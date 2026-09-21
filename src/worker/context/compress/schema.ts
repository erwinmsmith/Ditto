import type { ContextCompressInput } from "./types.js";
import { context, nonnegativeInteger, object } from "../validation.js";

export function validateCompress(value: unknown): asserts value is ContextCompressInput {
  const input = object(value, "input");
  context(input.context);
  if (input.maxTokens !== undefined) nonnegativeInteger(input.maxTokens, "maxTokens");
  if (input.maxItems !== undefined) nonnegativeInteger(input.maxItems, "maxItems");
}
