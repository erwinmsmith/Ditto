import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MemoryError, type MemoryItem, type MemoryStore, type MemorySearchProvider, type MemoryCallOptions } from "@codesoul-co/ditto/worker/memory";
import { embedContents, type EmbeddingProvider } from "@codesoul-co/ditto-retrieval";
export interface QdrantOptions { url: string; collection: string; dimensions: number; embedding: EmbeddingProvider; embeddingIdentity: string; apiKey?: string }
export class QdrantClient {
  readonly url: string; readonly apiKey: string | undefined;
  constructor(url: string, apiKey?: string) { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid Qdrant endpoint"); this.url = parsed.href.replace(/\/$/, ""); this.apiKey = apiKey; }
  async request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.url + path, { method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { "content-type": "application/json", ...(this.apiKey ? { "api-key": this.apiKey } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new MemoryError(`QDRANT_HTTP_${response.status}`, "Qdrant request failed"); }
    if (!response.body) throw new MemoryError("INVALID_BACKEND_OUTPUT", "Empty Qdrant response");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024 * 1024) throw new MemoryError("RESULT_LIMIT", "Qdrant response exceeds limit"); chunks.push(part.value); } } finally { await reader.cancel(); }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status: unknown; result: T };
    if (parsed.status !== "ok") throw new MemoryError("QDRANT_ERROR", "Qdrant operation failed"); return parsed.result;
  }
}
export function memoryPointId(key: string) {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
interface Point { id: string; payload: MemoryItem; score?: number }
const uuid = (id: string) => { if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new MemoryError("INVALID_INPUT", "Qdrant Memory IDs must be UUIDs"); return id; };
const map = (p: Point): MemoryItem => { if (!p.payload || p.id !== p.payload.id) throw new MemoryError("INVALID_BACKEND_OUTPUT", "Qdrant payload identity mismatch"); return p.payload; };
const filter = (input?: Record<string, unknown>) => ({ must: Object.entries(input ?? {}).map(([key, value]) => {
  if (!["key", "namespace", "kind"].includes(key) || typeof value !== "string") throw new MemoryError("INVALID_INPUT", "Qdrant filter supports string key, namespace and kind");
  return { key: key === "key" ? "key" : `metadata.${key}`, match: { value } };
}) });
/** Qdrant stores full Memory records. Named text vectors exist only for searchable preferences. */
export async function openQdrantMemory(options: QdrantOptions) {
  if (!/^[a-z][a-z0-9_]{0,100}$/.test(options.collection) || !Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || !options.embeddingIdentity) throw new Error("Invalid Qdrant configuration");
  const client = new QdrantClient(options.url, options.apiKey), path = `/collections/${options.collection}`, schemaId = "00000000-0000-5000-8000-000000000001";
  const schema = { identity: options.embeddingIdentity, dimensions: options.dimensions, preprocessing: "preference.content.text/v1", distance: "Cosine" };
  try { await client.request(path); }
  catch (error) { if (!(error instanceof MemoryError) || error.code !== "QDRANT_HTTP_404") throw error; await client.request(path, "PUT", { vectors: { text: { size: options.dimensions, distance: "Cosine" } } }); }
  const collection = await client.request<{ config: { params: { vectors: { text?: { size: number; distance: string } } } } }>(path);
  if (collection.config.params.vectors.text?.size !== options.dimensions || collection.config.params.vectors.text?.distance !== "Cosine") throw new Error("Qdrant vector schema mismatch");
  const stored = await client.request<{ payload: unknown }[]>(`${path}/points`, "POST", { ids: [schemaId], with_payload: true, with_vector: false });
  if (stored.length) { if (!isDeepStrictEqual(stored[0]!.payload, schema)) throw new Error("Embedding model/preprocessing changed; use a new collection and reindex"); }
  else { // Provision only an empty collection; never attach a new embedding identity to existing data.
    const count = await client.request<{ count: number }>(`${path}/points/count`, "POST", { exact: true }); if (count.count) throw new Error("Collection has no embedding schema manifest");
    await client.request(`${path}/points?wait=true`, "PUT", { points: [{ id: schemaId, payload: schema, vector: {} }] });
  }
  const stats = { embeddingCalls: 0, embeddedTexts: 0, vectorQueries: 0 };
  const embed = async (texts: string[], purpose: "query" | "document", controls?: MemoryCallOptions) => { stats.embeddingCalls++; stats.embeddedTexts += texts.length; return embedContents(options.embedding, { contents: texts, purpose }, { dimensions: options.dimensions }, controls?.signal ? { signal: controls.signal } : {}); };
  const get: MemoryStore["get"] = async (input, controls) => {
    const points = new Map<string, Point>();
    if (input.ids?.length) for (const point of await client.request<Point[]>(`${path}/points`, "POST", { ids: input.ids.map(uuid), with_payload: true, with_vector: false }, controls?.signal)) if (point.id !== schemaId) points.set(point.id, point);
    if (input.keys?.length) {
      let offset: string | undefined;
      do { const page = await client.request<{ points: Point[]; next_page_offset?: string | null }>(`${path}/points/scroll`, "POST", { filter: { must: [{ key: "key", match: { any: input.keys } }] }, limit: 256, with_payload: true, with_vector: false, ...(offset ? { offset } : {}) }, controls?.signal); for (const point of page.points) points.set(point.id, point); offset = page.next_page_offset ?? undefined; if (points.size > 10000) throw new MemoryError("RESULT_LIMIT", "Split Memory GET into smaller batches"); } while (offset);
    }
    return [...points.values()].map(map);
  };
  async function save(items: MemoryItem[], controls?: MemoryCallOptions) {
    const searchable = items.filter(i => i.metadata?.kind === "preference");
    const texts = searchable.map(i => { const c = i.content as { text?: unknown } | null; if (typeof c?.text !== "string" || !c.text.trim() || c.text.length > 8000) throw new MemoryError("INVALID_INPUT", "Searchable Memory requires bounded content.text"); return c.text; });
    const vectors = texts.length ? await embed(texts, "document", controls) : [], byId = new Map(searchable.map((item, index) => [item.id, vectors[index]!]));
    if (items.length) {
      const result = await client.request<{ status: string }>(`${path}/points?wait=true&ordering=strong`, "PUT", { points: items.map(item => ({ id: item.id, payload: item, vector: byId.has(item.id) ? { text: byId.get(item.id) } : {} })) }, controls?.signal);
      if (result.status !== "completed") throw new MemoryError("WRITE_UNCONFIRMED", "Qdrant mutation was not completed; reconcile before retrying");
    }
    return items;
  }
  const store: MemoryStore & MemorySearchProvider = {
    get,
    async query(input, controls) {
      if (input.orderBy?.some(o => o.field !== "id" || (o.direction ?? "asc") !== "asc")) throw new MemoryError("INVALID_INPUT", "Qdrant supports ID ascending pagination");
      if (input.limit === 0) return { items: [] };
      const page = await client.request<{ points: Point[]; next_page_offset?: string | null }>(`${path}/points/scroll`, "POST", { filter: filter(input.filter), limit: input.limit ?? 100, with_payload: true, with_vector: false, ...(input.cursor ? { offset: uuid(input.cursor) } : {}) }, controls?.signal);
      return { items: page.points.filter(p => p.id !== schemaId).map(map), ...(page.next_page_offset ? { nextCursor: String(page.next_page_offset) } : {}) };
    },
    async search(input, controls) {
      if (input.strategy !== undefined && input.strategy !== "vector" || typeof input.query !== "string" || !input.query.trim() || Object.keys(input.options ?? {}).length) throw new MemoryError("INVALID_INPUT", "Qdrant supports text queries with vector strategy");
      if (input.limit === 0) return [];
      const [vector] = await embed([input.query], "query", controls); stats.vectorQueries++;
      const result = await client.request<{ points: Point[] }>(`${path}/points/query`, "POST", { query: vector, using: "text", filter: filter(input.filter), limit: input.limit ?? 10, with_payload: true, with_vector: false }, controls?.signal);
      return result.points.map(p => ({ memory: map(p), ...(p.score === undefined ? {} : { score: p.score }) }));
    },
    async write(input, controls) {
      const items = input.memories.map(m => ({ ...m, id: m.key ? memoryPointId(m.key) : randomUUID() }));
      if (new Set(items.map(i => i.id)).size !== items.length) throw new MemoryError("INVALID_INPUT", "Duplicate Memory keys");
      const existing = new Map((await get({ ids: items.map(i => i.id) }, controls)).map(i => [i.id, i]));
      for (const item of items) if (existing.has(item.id) && !isDeepStrictEqual(existing.get(item.id), item)) throw new MemoryError("KEY_CONFLICT", "Memory key conflicts with existing content");
      await save(items.filter(i => !existing.has(i.id)), controls); return items;
    },
    async update(input, controls) {
      const existing = new Map((await get({ ids: input.memories.map(i => i.id) }, controls)).map(i => [i.id, i]));
      if (existing.size !== input.memories.length) throw new MemoryError("NOT_FOUND", "Update target missing");
      // Full upsert regenerates content vectors and replaces payload together. Metadata is replacement, not merge.
      return save(input.memories.map(change => ({ ...existing.get(change.id)!, ...change })), controls);
    },
    async delete(input, controls) {
      const found = await get(input, controls); if (!found.length) return { deleted: [] }; const ids = found.map(i => i.id);
      const result = await client.request<{ status: string }>(`${path}/points/delete?wait=true&ordering=strong`, "POST", { points: ids }, controls?.signal);
      if (result.status !== "completed") throw new MemoryError("WRITE_UNCONFIRMED", "Qdrant delete not confirmed"); return { deleted: ids };
    },
  };
  return { store, client, stats, async close() {} };
}
