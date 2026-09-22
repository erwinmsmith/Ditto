import { randomUUID } from "node:crypto";
import type { ContextOperationQueue, ContextStateStore, StoredContext } from "./types.js";
import { checkedStoredContext, contextScopeKey } from "./state.js";
import { check, context, nonempty, ContextError } from "./validation.js";

export interface InMemoryContextOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}
/** Bounded, process-local LRU cache. CAS is atomic within this JavaScript isolate. */
export function createInMemoryContextStore(options: InMemoryContextOptions = {}): ContextStateStore {
  const ttlMs = options.ttlMs ?? 3_600_000;
  const maxEntries = options.maxEntries ?? 1000;
  check(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 2 ** 31 - 1, "Invalid Context ttlMs");
  check(Number.isSafeInteger(maxEntries) && maxEntries > 0, "Invalid Context maxEntries");
  const now = options.now ?? Date.now;
  const entries = new Map<string, { stored: StoredContext; expires: number }>();
  const current = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= now()) { entries.delete(key); return undefined; }
    return entry;
  };
  return Object.freeze({
    async get(scope, call = {}) {
      call.signal?.throwIfAborted();
      const key = contextScopeKey(scope), entry = current(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.stored; // Deeply frozen on write; reads do not refresh expiry.
    },
    async compareAndSet(scope, expectedVersion, next, call = {}) {
      call.signal?.throwIfAborted();
      const key = contextScopeKey(scope);
      if (expectedVersion !== undefined) nonempty(expectedVersion, "expectedVersion");
      context(next);
      if (current(key)?.stored.version !== expectedVersion) {
        throw new ContextError("STATE_CONFLICT", "Context changed or expired; reload before retrying");
      }
      const stored = checkedStoredContext({ version: randomUUID(), context: next });
      entries.delete(key);
      if (entries.size >= maxEntries) {
        const time = now();
        for (const [id, entry] of entries) if (entry.expires <= time) entries.delete(id);
      }
      entries.set(key, { stored, expires: now() + ttlMs });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return stored;
    },
  } satisfies ContextStateStore);
}

/** Serialize one scope without blocking other scopes; failed jobs never poison the queue. */
export function createContextOperationQueue(options: { readonly maxPending?: number } = {}): ContextOperationQueue {
  const maxPending = options.maxPending ?? 1024;
  check(Number.isSafeInteger(maxPending) && maxPending > 0, "Invalid Context maxPending");
  const tails = new Map<string, Promise<void>>();
  let pending = 0;
  return Object.freeze({
    enqueue(scope, operation, call = {}) {
      call.signal?.throwIfAborted();
      const key = contextScopeKey(scope);
      if (pending >= maxPending) return Promise.reject(new ContextError("QUEUE_FULL", "Context queue capacity exceeded"));
      pending++;
      const job = (tails.get(key) ?? Promise.resolve()).then(() => {
        call.signal?.throwIfAborted();
        return operation();
      });
      const result = job.finally(() => {
        pending--;
        if (tails.get(key) === tail) tails.delete(key);
      });
      const tail = result.then(() => {}, () => {});
      tails.set(key, tail);
      return result;
    },
  } satisfies ContextOperationQueue);
}
