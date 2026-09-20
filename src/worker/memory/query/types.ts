import type { MemoryItem } from "../types.js";
export interface MemoryQueryInput {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
}
export interface MemoryQueryOutput { items: readonly MemoryItem[]; nextCursor?: string; }
