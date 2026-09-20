import type { MemoryDraft, MemoryItem } from "../types.js";
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
