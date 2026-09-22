import type { RuntimeClient } from "../execution-context.js";
export interface MemoryItem { id: string; key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemoryDraft { key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemorySearchResult { memory: MemoryItem; score?: number; metadata?: Record<string, unknown>; }

export interface MemoryDefaults { readonly queryLimit?: number; readonly searchLimit?: number; }

/** Per-call controls, never part of a database record or Node payload. */
export interface MemoryCallOptions {
  readonly signal?: AbortSignal;
  /** Worker-supplied invocation scope for optional delegation. */
  readonly runtime?: Pick<RuntimeClient, "invoke">;
}
