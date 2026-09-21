import type { ContextSelectInput } from "./types.js";
import {
  check, context, jsonObject, messageContent, nonempty, nonnegativeInteger, object, reference,
} from "../validation.js";

export function validateSelect(value: unknown): asserts value is ContextSelectInput {
  const input = object(value, "input");
  context(input.context);
  check(input.purpose === "infer" || input.purpose === "memory", "purpose must be infer or memory");
  if (input.query !== undefined) messageContent(input.query, "query");
  if (input.limit !== undefined) nonnegativeInteger(input.limit, "limit");
  if (input.maxTokens !== undefined) nonnegativeInteger(input.maxTokens, "maxTokens");
  if (input.strategy === undefined) return;
  const strategy = object(input.strategy, "strategy");
  check(strategy.kind === "default" || strategy.kind === "rag" || strategy.kind === "provider", "strategy.kind is invalid");
  if (strategy.kind === "rag") {
    if (strategy.corpus !== undefined) reference(strategy.corpus, "strategy.corpus");
    if (strategy.options !== undefined) jsonObject(strategy.options, "strategy.options");
  }
  if (strategy.kind === "provider") {
    nonempty(strategy.name, "strategy.name");
    if (strategy.options !== undefined) jsonObject(strategy.options, "strategy.options");
  }
}
