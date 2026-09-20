import type { MemorySearchResult } from "../types.js";
export interface MemorySearchInput { query: unknown; strategy?: string; filter?: Record<string, unknown>; limit?: number; options?: Record<string, unknown>; }
export type MemorySearchOutput = readonly MemorySearchResult[];
