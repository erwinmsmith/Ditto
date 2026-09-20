import type { MemoryItem } from "../types.js";
export interface MemoryUpdateEntry { id: string; content?: unknown; metadata?: Record<string, unknown>; }
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
