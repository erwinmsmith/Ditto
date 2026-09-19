import type { InferCacheKey } from "../types.js";
export interface CacheLookupInput { key: InferCacheKey }
export interface CacheLookupOutput { hit: boolean; value?: unknown }
