import type { InferCacheKey } from "../types.js";
export interface CacheInvalidateInput {
  selector: { type: "key"; key: InferCacheKey } | { type: "tag"; tag: string } | { type: "namespace"; namespace: string };
}
export interface CacheInvalidateOutput { invalidated: number }
