import type {
  Context, ContextIngress, ContextItem, ContextSource, EmbeddingRecord,
  KnowledgeItem, Message, MessageContent, RagCandidate, Reference, Skill,
} from "../../contracts/common.js";

export type {
  Context, ContextIngress, ContextItem, ContextSource, EmbeddingRecord,
  KnowledgeItem, RagCandidate, Skill,
} from "../../contracts/common.js";

export interface ContextLoadInput { sources: readonly ContextSource[]; }
export type ContextLoadOutput = Context;
export interface ContextSelectInput { context: Context; query: Message; limit?: number; }
export type ContextSelectOutput = Context;
export interface ContextUpdateInput {
  context: Context;
  add?: readonly ContextItem[];
  ingress?: readonly ContextIngress[];
  removeIds?: readonly string[];
}
export type ContextUpdateOutput = Context;
export interface ContextCompressInput {
  context: Context;
  maxTokens?: number;
  maxItems?: number;
}
export type ContextCompressOutput = Context;

export interface ContextRagEmbedInput { items: readonly KnowledgeItem[]; }
export type ContextRagEmbedOutput = readonly EmbeddingRecord[];
export interface ContextRagRetrieveInput {
  query: MessageContent;
  corpus: Reference | readonly KnowledgeItem[];
  limit?: number;
  strategy?: string;
}
export type ContextRagRetrieveOutput = readonly RagCandidate[];
export interface ContextRagRankInput {
  query: MessageContent;
  candidates: readonly RagCandidate[];
  limit?: number;
  strategy?: string;
}
export type ContextRagRankOutput = readonly RagCandidate[];
export interface ContextSkillInput { context: Context; skill: Skill; }
export type ContextSkillOutput = Context;

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
    "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
    "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
    "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
    "CONTEXT.RAG.EMBED": NodeContract<ContextRagEmbedInput, ContextRagEmbedOutput>;
    "CONTEXT.RAG.RETRIEVE": NodeContract<ContextRagRetrieveInput, ContextRagRetrieveOutput>;
    "CONTEXT.RAG.RANK": NodeContract<ContextRagRankInput, ContextRagRankOutput>;
    "CONTEXT.SKILL": NodeContract<ContextSkillInput, ContextSkillOutput>;
  }
}
