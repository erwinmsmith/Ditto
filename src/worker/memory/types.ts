export interface MemoryItem { id: string; key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemoryDraft { key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemorySearchResult { memory: MemoryItem; score?: number; metadata?: Record<string, unknown>; }

export interface MemoryDefaults { readonly queryLimit?: number; readonly searchLimit?: number; }
