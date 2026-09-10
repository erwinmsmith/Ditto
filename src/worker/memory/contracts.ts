import type { Message } from "../../contracts/common.js";

export interface MemoryDraft {
  message: Message;
}

export interface MemoryItem {
  id: string;
  message: Message;
}

export interface MemoryReference {
  id: string;
}

export interface MemoryRetrieveInput {
  query: Message;
}
export type MemoryRetrieveOutput = readonly MemoryItem[];

export interface MemoryWriteInput {
  memories: readonly MemoryDraft[];
}
export type MemoryWriteOutput = readonly MemoryItem[];

export interface MemoryUpdateInput {
  memories: readonly MemoryItem[];
}
export type MemoryUpdateOutput = readonly MemoryItem[];

export interface MemoryConsolidateInput {
  memories: readonly MemoryItem[];
}
export type MemoryConsolidateOutput = readonly MemoryItem[];

export interface MemoryEvictInput {
  memories: readonly MemoryReference[];
}
export type MemoryEvictOutput = readonly MemoryReference[];


declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "MEMORY.RETRIEVE": NodeContract<MemoryRetrieveInput, MemoryRetrieveOutput>;
    "MEMORY.WRITE": NodeContract<MemoryWriteInput, MemoryWriteOutput>;
    "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, MemoryUpdateOutput>;
    "MEMORY.CONSOLIDATE": NodeContract<MemoryConsolidateInput, MemoryConsolidateOutput>;
    "MEMORY.EVICT": NodeContract<MemoryEvictInput, MemoryEvictOutput>;
  }
}
