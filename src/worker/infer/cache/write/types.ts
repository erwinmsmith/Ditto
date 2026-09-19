import type { InferCacheKey } from "../types.js";
export interface CacheWriteInput { key: InferCacheKey; value: unknown; ttlMs?: number; tags?: string[] }
export interface CacheWriteOutput { written: boolean; key: InferCacheKey }
