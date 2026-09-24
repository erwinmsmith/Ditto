import { MemoryError, type MemoryStore, type MemorySearchProvider, type MemoryItem } from "@codesoul-co/ditto/worker/memory";
/** Controller-provided scope; enforced for reads, search and mutations on every backend. */
export function scopedMemory(store: MemoryStore & MemorySearchProvider, namespace: string): MemoryStore & MemorySearchProvider {
  if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid Memory namespace");
  const own = (item: MemoryItem) => item.metadata?.namespace === namespace && item.key?.startsWith(namespace + ":");
  const key = (k: string | undefined) => { if (!k?.startsWith(namespace + ":")) throw new MemoryError("SCOPE_DENIED", "Memory key is outside the controller scope"); return k; };
  const filter = (value?: Record<string, unknown>) => { if (value?.namespace !== undefined && value.namespace !== namespace) throw new MemoryError("SCOPE_DENIED", "Memory filter is outside the controller scope"); return { ...value, namespace }; };
  const metadata = (value?: Record<string, unknown>) => { if (value?.namespace !== undefined && value.namespace !== namespace) throw new MemoryError("SCOPE_DENIED", "Memory metadata is outside the controller scope"); return { ...value, namespace }; };
  const get: MemoryStore["get"] = async (input, options) => { input.keys?.forEach(key); return (await store.get(input, options)).filter(own); };
  return {
    get,
    async query(input, options) { const result = await store.query({ ...input, filter: filter(input.filter) }, options); if (!result.items.every(own)) throw new MemoryError("SCOPE_DENIED", "Backend returned out-of-scope memories"); return result; },
    async search(input, options) { const result = await store.search({ ...input, filter: filter(input.filter) }, options); if (!result.every(r => own(r.memory))) throw new MemoryError("SCOPE_DENIED", "Backend returned out-of-scope memories"); return result; },
    write: (input, options) => store.write({ memories: input.memories.map(m => ({ ...m, key: key(m.key), metadata: metadata(m.metadata) })) }, options),
    async update(input, options) { const records = await get({ ids: input.memories.map(m => m.id) }, options); if (records.length !== input.memories.length) throw new MemoryError("NOT_FOUND", "Scoped update target missing"); return store.update({ memories: input.memories.map(m => ({ ...m, ...(m.metadata ? { metadata: metadata(m.metadata) } : {}) })) }, options); },
    async delete(input, options) { const found = await get(input, options); return store.delete({ ids: found.map(m => m.id) }, options); },
  };
}
