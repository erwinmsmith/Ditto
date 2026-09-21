import type {
  ContextItem, JsonObject, MessageContent, Reference,
} from "../../../../contracts/common.js";
import type { ContextRagStrategy } from "../../types.js";
import type { ContextSelectInput } from "../types.js";

export interface RagCandidate {
  readonly item: ContextItem;
  readonly score?: number;
  readonly metadata?: JsonObject;
}

export interface RagEmbedInput {
  readonly query?: MessageContent;
  readonly items: readonly ContextItem[];
  readonly corpus?: Reference;
  readonly options?: JsonObject;
}

export interface RagRetrieveInput extends RagEmbedInput {
  readonly embedding?: unknown;
}

export interface RagRankInput extends RagEmbedInput {
  readonly candidates: readonly RagCandidate[];
}

export interface RagEmbedStep {
  embed(input: RagEmbedInput): Promise<unknown>;
}

export interface RagRetrieveStep {
  retrieve(input: RagRetrieveInput): Promise<readonly RagCandidate[]>;
}

export interface RagRankStep {
  rank(input: RagRankInput): Promise<readonly RagCandidate[]>;
}

export interface RagPipeline {
  readonly embed?: RagEmbedStep;
  readonly retrieve: RagRetrieveStep;
  readonly rank?: RagRankStep;
}

/** Creates an internal SELECT strategy; embed/retrieve/rank are never registered as Nodes. */
export function createRagStrategy(pipeline: RagPipeline): ContextRagStrategy {
  return Object.freeze({
    async select(input: ContextSelectInput): Promise<readonly ContextItem[]> {
      const strategy = input.strategy?.kind === "rag" ? input.strategy : { kind: "rag" as const };
      const base: RagEmbedInput = {
        items: input.context.items,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(strategy.corpus === undefined ? {} : { corpus: strategy.corpus }),
        ...(strategy.options === undefined ? {} : { options: strategy.options }),
      };
      const embedding = await pipeline.embed?.embed(base);
      const retrieved = await pipeline.retrieve.retrieve({
        ...base,
        ...(embedding === undefined ? {} : { embedding }),
      });
      const ranked = pipeline.rank ? await pipeline.rank.rank({ ...base, candidates: retrieved }) : retrieved;
      const unique = new Map<string, ContextItem>();
      for (const candidate of ranked) if (!unique.has(candidate.item.id)) unique.set(candidate.item.id, candidate.item);
      return [...unique.values()];
    },
  });
}
