import type { ContextItem } from "../../../../contracts/common.js";
import type { ContextSelectInput } from "../types.js";
import { booleanMetadata, numericMetadata, textContent } from "../../execution.js";

function terms(value: string): ReadonlySet<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function overlap(query: ReadonlySet<string>, item: ContextItem): number {
  if (!query.size) return 0;
  const content = terms(textContent(item.content));
  let matches = 0;
  for (const term of query) if (content.has(term)) matches++;
  return matches / query.size;
}

/** Dependency-free deterministic selector used when no strategy is requested. */
export async function defaultSelect(input: ContextSelectInput): Promise<readonly ContextItem[]> {
  const query = terms(input.query === undefined ? "" : textContent(input.query));
  return input.context.items
    .map((item, index) => {
      const protectedScore = input.purpose === "infer" && (
        booleanMetadata(item, "protected")
        || booleanMetadata(item, "currentGoal")
        || item.metadata?.role === "system"
      ) ? 1_000_000 : 0;
      const memoryScore = input.purpose === "memory"
        ? (booleanMetadata(item, "memoryCandidate") ? 500 : 0)
          + (booleanMetadata(item, "reusable") ? 100 : 0)
          + (booleanMetadata(item, "stable") ? 50 : 0)
        : 0;
      return {
        item,
        index,
        score: protectedScore + memoryScore
          + numericMetadata(item, "priority") * 100
          + numericMetadata(item, "relevance") * 10
          + overlap(query, item) * 1_000
          + index / Math.max(1, input.context.items.length),
      };
    })
    .filter(({ item }) => input.purpose !== "memory"
      || (item.metadata?.private !== true && item.metadata?.memoryEligible !== false))
    .sort((a, b) => b.score - a.score || a.index - b.index || a.item.id.localeCompare(b.item.id))
    .map(({ item }) => item);
}
