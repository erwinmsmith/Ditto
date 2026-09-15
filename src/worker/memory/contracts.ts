import type {
  EmbeddingRecord, MemoryDraft, MemoryItem, MemoryRagCandidate,
  MemoryReference, MemorySelector, Message, MessageContent, Reference, Skill,
} from "../../contracts/common.js";

export type {
  EmbeddingRecord, MemoryDraft, MemoryItem, MemoryRagCandidate,
  MemoryReference, MemorySelector, Skill,
} from "../../contracts/common.js";

export interface MemoryRetrieveInput { selector: MemorySelector; limit?: number; }
export type MemoryRetrieveOutput = readonly MemoryItem[];
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
export interface MemoryUpdateEntry { id: string; message: Message; metadata?: import("../../contracts/common.js").JsonObject; }
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
export interface MemoryConsolidateInput { memories: readonly MemoryReference[]; strategy?: string; }
export type MemoryConsolidateOutput = readonly MemoryItem[];
export type MemoryEvictMode = "delete" | "invalidate" | "deprioritize";
export interface MemoryEvictInput { memories: readonly MemoryReference[]; mode: MemoryEvictMode; }
export type MemoryEvictOutput = readonly MemoryReference[];

export interface MemoryRagEmbedInput { memories: readonly MemoryItem[]; }
export type MemoryRagEmbedOutput = readonly EmbeddingRecord[];
export interface MemoryRagRetrieveInput {
  query: MessageContent;
  corpus?: Reference;
  limit?: number;
  strategy?: string;
}
export type MemoryRagRetrieveOutput = readonly MemoryRagCandidate[];
export interface MemoryRagRankInput {
  query: MessageContent;
  candidates: readonly MemoryRagCandidate[];
  limit?: number;
  strategy?: string;
}
export type MemoryRagRankOutput = readonly MemoryRagCandidate[];
export interface MemorySkillInput { name: string; version?: string; }
export type MemorySkillOutput = Skill;

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "MEMORY.RETRIEVE": NodeContract<MemoryRetrieveInput, MemoryRetrieveOutput>;
    "MEMORY.WRITE": NodeContract<MemoryWriteInput, MemoryWriteOutput>;
    "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, MemoryUpdateOutput>;
    "MEMORY.CONSOLIDATE": NodeContract<MemoryConsolidateInput, MemoryConsolidateOutput>;
    "MEMORY.EVICT": NodeContract<MemoryEvictInput, MemoryEvictOutput>;
    "MEMORY.RAG.EMBED": NodeContract<MemoryRagEmbedInput, MemoryRagEmbedOutput>;
    "MEMORY.RAG.RETRIEVE": NodeContract<MemoryRagRetrieveInput, MemoryRagRetrieveOutput>;
    "MEMORY.RAG.RANK": NodeContract<MemoryRagRankInput, MemoryRagRankOutput>;
    "MEMORY.SKILL": NodeContract<MemorySkillInput, MemorySkillOutput>;
  }
}
