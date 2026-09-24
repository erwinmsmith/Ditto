import { randomUUID } from "node:crypto";
import { MemoryError, type MemoryItem, type MemoryStore, type MemorySearchProvider } from "@codesoul-co/ditto/worker/memory";
import { exampleSdk, runMemoryExample } from "./shared.ts";

interface Status { error_code?: string; code?: number; reason?: string }
interface Row { id: string; payload: string; score?: number }
export interface MilvusClientPort {
  query(input: object): Promise<{ status: Status; data: Row[] }>;
  search(input: object): Promise<{ status: Status; results: Row[] }>;
  insert(input: object): Promise<{ status: Status; err_index?: number[] }>;
  upsert(input: object): Promise<{ status: Status; err_index?: number[] }>;
  delete(input: object): Promise<{ status: Status; delete_cnt: string }>;
}
const DIMENSIONS = 3; // Explicit fixture vectors; use your embedding model's dimension in an application.
const MAX_GET = 10000;
function check(status: Status) {
  if ((!('code' in status) && !('error_code' in status)) || (status.code !== undefined && status.code !== 0)
    || (status.error_code !== undefined && status.error_code !== "Success")) {
    throw new MemoryError("MILVUS_ERROR", "Milvus operation failed");
  }
}
function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== DIMENSIONS || !value.every(v => typeof v === "number" && Number.isFinite(v))
    || !value.some(v => v !== 0)) throw new MemoryError("INVALID_INPUT", `Expected ${DIMENSIONS} finite vector dimensions, nonzero for cosine`);
  return value;
}
function record(item: MemoryItem) {
  const content = item.content as { vector?: unknown } | null;
  const payload = JSON.stringify(item);
  if (Buffer.byteLength(payload) > 65535 || Buffer.byteLength(item.key ?? "") > 255) {
    throw new MemoryError("INVALID_INPUT", "Memory exceeds the example Milvus VARCHAR limit");
  }
  return { id: item.id, memory_key: item.key ?? "", payload, vector: vector(content?.vector) };
}

/** Single-writer collection example. Milvus is the store and native vector search backend. */
export function createMilvusMemoryStore(client: MilvusClientPort, collection: string): MemoryStore & MemorySearchProvider {
  const base = { collection_name: collection, output_fields: ["id", "payload"], consistency_level: "Strong" };
  const map = (row: Row): MemoryItem => {
    const item = JSON.parse(row.payload) as MemoryItem;
    if (item.id !== row.id) throw new MemoryError("INVALID_BACKEND_OUTPUT", "Milvus payload ID differs from primary key");
    return item;
  };
  const query = async (filter: string, exprValues: Record<string, unknown>, limit: number) => {
    const response = await client.query({ ...base, filter, exprValues, limit }); check(response.status); return response.data;
  };
  const filter = (input?: Record<string, unknown>) => {
    if (!input || !Object.keys(input).length) return { filter: "", values: {} };
    if (Object.keys(input).some(key => key !== "key") || typeof input.key !== "string") {
      throw new MemoryError("INVALID_INPUT", "Milvus example supports filter: { key: string }");
    }
    return { filter: "memory_key == {memoryKey}", values: { memoryKey: input.key } };
  };
  const get: MemoryStore["get"] = async input => {
    const clauses: string[] = [], values: Record<string, unknown> = {};
    if (input.ids?.length) { clauses.push("id in {ids}"); values.ids = input.ids; }
    if (input.keys?.length) { clauses.push("memory_key in {keys}"); values.keys = input.keys; }
    if (!clauses.length) return [];
    const rows = await query(clauses.join(" or "), values, MAX_GET + 1);
    if (rows.length > MAX_GET) throw new MemoryError("RESULT_LIMIT", "Split GET into smaller requests");
    return rows.map(map);
  };
  const mutate = async (method: "insert" | "upsert", items: MemoryItem[]) => {
    if (!items.length) return items;
    const response = await client[method]({ collection_name: collection, data: items.map(record) });
    check(response.status);
    if (response.err_index?.length) throw new MemoryError("PARTIAL_WRITE", "Milvus reported failed rows; reconcile before retrying");
    return items;
  };
  return {
    get,
    async query(input) {
      if (input.cursor !== undefined || input.orderBy?.length) {
        throw new MemoryError("UNSUPPORTED_QUERY", "This bounded Milvus example does not implement cursor or ordering");
      }
      const where = filter(input.filter);
      return { items: (await query(where.filter, where.values, input.limit ?? 100)).map(map) };
    },
    async search(input) {
      if ((input.strategy && input.strategy !== "vector") || Object.keys(input.options ?? {}).length) {
        throw new MemoryError("UNSUPPORTED_STRATEGY", "Milvus example supports vector search without options");
      }
      const where = filter(input.filter);
      const response = await client.search({ ...base, data: [vector(input.query)], anns_field: "vector",
        filter: where.filter, exprValues: where.values, metric_type: "COSINE", limit: input.limit ?? 10,
      });
      check(response.status);
      return response.results.map(row => ({ memory: map(row), ...(row.score === undefined ? {} : { score: row.score }) }));
    },
    write: input => mutate("insert", input.memories.map(item => ({ ...item, id: randomUUID() }))),
    async update(input) {
      const found = new Map((await get({ ids: input.memories.map(item => item.id) })).map(item => [item.id, item]));
      if (found.size !== input.memories.length) throw new MemoryError("NOT_FOUND", "Update target does not exist");
      // Full upsert preserves key/content/metadata. Content changes must provide the matching vector.
      return mutate("upsert", input.memories.map(change => ({ ...found.get(change.id)!, ...change })));
    },
    async delete(input) {
      const ids = (await get({ ids: input.ids })).map(item => item.id);
      if (!ids.length) return { deleted: [] };
      const response = await client.delete({ collection_name: collection, ids, consistency_level: "Strong" });
      check(response.status);
      if (Number(response.delete_cnt) !== ids.length) throw new MemoryError("PARTIAL_DELETE", "Milvus deletion count differs; reconcile before retrying");
      return { deleted: ids };
    },
  };
}

export async function main() {
  type Client = MilvusClientPort & {
    createCollection(input: object): Promise<Status>; createIndex(input: object): Promise<Status>;
    dropCollection(input: object): Promise<Status>;
    loadCollectionSync(input: object): Promise<Status>; closeConnection(): Promise<unknown>;
  };
  const { MilvusClient, DataType } = exampleSdk("@zilliz/milvus2-sdk-node") as {
    MilvusClient: new (config: object) => Client; DataType: { VarChar: number; FloatVector: number };
  };
  const address = process.env.DITTO_WORKER_MEMORY_MILVUS_ADDRESS;
  if (!address) throw new Error("Set DITTO_WORKER_MEMORY_MILVUS_ADDRESS");
  const client = new MilvusClient({ address, ...(process.env.DITTO_WORKER_MEMORY_MILVUS_TOKEN ? { token: process.env.DITTO_WORKER_MEMORY_MILVUS_TOKEN } : {}), timeout: 30000 });
  const collection = `ditto_example_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    check(await client.createCollection({ collection_name: collection, consistency_level: "Strong",
      fields: [
        { name: "id", data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 36 },
        { name: "memory_key", data_type: DataType.VarChar, max_length: 255 },
        { name: "payload", data_type: DataType.VarChar, max_length: 65535 },
        { name: "vector", data_type: DataType.FloatVector, dim: DIMENSIONS },
      ],
    }));
    created = true;
    check(await client.createIndex({ collection_name: collection, field_name: "vector", index_type: "FLAT", metric_type: "COSINE" }));
    check(await client.loadCollectionSync({ collection_name: collection }));
    await runMemoryExample({ store: createMilvusMemoryStore(client, collection) }, [1, 0, 0], [
      { key: "preference", content: { text: "Preferred language is Chinese", vector: [1, 0, 0] }, metadata: { source: "user" } },
      { key: "topic", content: { text: "Worker API examples", vector: [0, 1, 0] } },
    ]);
  } finally {
    try { if (created) check(await client.dropCollection({ collection_name: collection })); }
    finally { await client.closeConnection(); }
  }
}

if (import.meta.main) await main();
