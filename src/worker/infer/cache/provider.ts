import type { CacheLookupInput, CacheLookupOutput, CacheWriteInput, CacheWriteOutput, CacheInvalidateInput, CacheInvalidateOutput } from "./index.js";
import { number } from "../validation.js";
export interface InferCacheProvider {
  lookup(input: CacheLookupInput): Promise<CacheLookupOutput>;
  write(input: CacheWriteInput): Promise<CacheWriteOutput>;
  invalidate(input: CacheInvalidateInput): Promise<CacheInvalidateOutput>;
}
interface Entry { input: CacheWriteInput; expiresAt: number }
const keyOf = (k: CacheLookupInput["key"]): string => JSON.stringify([k.namespace ?? "", k.scope, k.key]);
/** Bounded, LRU, isolated snapshots; no background timer. Use a shared backend for replicas. */
export class InMemoryInferCache implements InferCacheProvider {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.#maxEntries = options.maxEntries ?? 1000;
    number(this.#maxEntries, "maxEntries", 1, Number.MAX_SAFE_INTEGER, true);
    this.#now = options.now ?? Date.now;
  }
  #prune(): void { const now = this.#now(); for (const [key, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(key); }
  async lookup(input: CacheLookupInput): Promise<CacheLookupOutput> {
    const key = keyOf(input.key); const entry = this.#entries.get(key);
    if (!entry) return { hit: false };
    if (entry.expiresAt <= this.#now()) { this.#entries.delete(key); return { hit: false }; }
    this.#entries.delete(key); this.#entries.set(key, entry);
    return { hit: true, value: structuredClone(entry.input.value) };
  }
  async write(input: CacheWriteInput): Promise<CacheWriteOutput> {
    const snapshot = structuredClone(input); const key = keyOf(input.key);
    this.#entries.delete(key);
    if (input.ttlMs !== 0) {
      // Scan only under capacity pressure, before evicting a potentially live entry.
      if (this.#entries.size >= this.#maxEntries) this.#prune();
      this.#entries.set(key, { input: snapshot, expiresAt: input.ttlMs === undefined ? Infinity : this.#now() + input.ttlMs });
      if (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    }
    return { written: true, key: structuredClone(input.key) };
  }
  async invalidate({ selector }: CacheInvalidateInput): Promise<CacheInvalidateOutput> {
    const now = this.#now();
    if (selector.type === "key") {
      const key = keyOf(selector.key); const entry = this.#entries.get(key);
      this.#entries.delete(key);
      return { invalidated: entry && entry.expiresAt > now ? 1 : 0 };
    }
    let invalidated = 0;
    for (const [key, e] of this.#entries) {
      if (e.expiresAt <= now) { this.#entries.delete(key); continue; }
      if (selector.type === "tag" ? e.input.tags?.includes(selector.tag) : (e.input.key.namespace ?? "") === selector.namespace) {
        this.#entries.delete(key); invalidated++;
      }
    }
    return { invalidated };
  }
}
