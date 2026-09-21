import { RetrievalError, type RetrievalTarget } from "../types.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./types.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", message);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object");
  return value as Record<string, unknown>;
}
export function nonempty(value: unknown, field: string): asserts value is string {
  check(typeof value === "string" && value.trim().length > 0, `${field} must be a nonempty string`);
}
export function validateLimit(value: unknown): asserts value is number {
  check(typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10000, "limit must be an integer in 1..10000");
}
export function validateTarget(value: unknown): asserts value is RetrievalTarget {
  const target = object(value);
  nonempty(target.name, "target.name");
  if (target.type !== undefined) nonempty(target.type, "target.type");
  if (target.namespace !== undefined) nonempty(target.namespace, "target.namespace");
  if (target.metadata !== undefined) object(target.metadata);
}
export function validateSearch(value: unknown): asserts value is RetrievalSearchInput {
  const input = object(value);
  const query = object(input.query);
  check(Object.hasOwn(query, "content"), "query.content is required");
  if (query.metadata !== undefined) object(query.metadata);
  validateTarget(input.target);
  if (input.strategy !== undefined) nonempty(input.strategy, "strategy");
  if (input.limit !== undefined) validateLimit(input.limit);
  if (input.filter !== undefined) object(input.filter);
  if (input.options !== undefined) object(input.options);
}

/** Keep backend ranking, scores and provenance; normalize only the public envelope. */
export function normalizeOutput(value: unknown, input: RetrievalSearchInput): RetrievalSearchOutput {
  try {
    const output = object(value);
    validateTarget(output.target);
    check(output.target.name === input.target.name && output.target.namespace === input.target.namespace
      && output.target.type === input.target.type, "Backend returned a different target");
    if (output.strategy !== undefined) nonempty(output.strategy, "strategy");
    if (input.strategy !== undefined && output.strategy !== undefined) check(output.strategy === input.strategy, "Backend returned a different strategy");
    if (output.metadata !== undefined) object(output.metadata);
    check(Array.isArray(output.candidates), "candidates must be an array");
    if (input.limit !== undefined) check(output.candidates.length <= input.limit, "Backend exceeded the requested limit");
    for (const raw of output.candidates) {
      const candidate = object(raw);
      check(Object.hasOwn(candidate, "content"), "Candidate content is required");
      if (candidate.id !== undefined) nonempty(candidate.id, "candidate.id");
      if (candidate.score !== undefined) check(typeof candidate.score === "number" && Number.isFinite(candidate.score), "Invalid score");
      if (candidate.metadata !== undefined) object(candidate.metadata);
      if (candidate.source !== undefined) {
        const source = object(candidate.source);
        if (source.target !== undefined) nonempty(source.target, "source.target");
        if (source.ref !== undefined) nonempty(source.ref, "source.ref");
      }
    }
    const strategy = output.strategy ?? input.strategy;
    return {
      candidates: output.candidates,
      target: { ...input.target },
      ...(strategy === undefined ? {} : { strategy: strategy as string }),
      ...(output.metadata === undefined ? {} : { metadata: output.metadata as Record<string, unknown> }),
    };
  } catch {
    throw new RetrievalError("RETRIEVAL_INVALID_BACKEND_OUTPUT", "Retrieval backend returned an invalid result");
  }
}
