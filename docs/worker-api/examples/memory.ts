import { createDitto, graph, loadRuntimeConfigFile } from "@ditto/core";
import {
  createMemory, createMemoryWorker, MemoryError, memoryGetNode,
  type MemoryResources, type MemoryStore, type MemorySearchProvider,
} from "@ditto/core/worker/memory";

// example: setup
export function setupMemory(resources: MemoryResources) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const worker = createMemoryWorker({ ...resources, concurrency: 16 });
  const runtime = createDitto({ config, workers: [worker] });
  const memory = createMemory({ ...resources, defaults: config.memory });
  return { runtime, memory };
}

// example: get
export async function getMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.get({ ids: ["m1", "m1"], keys: ["preference"] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(item => ({ id: item.id, content: item.content }));
}

// example: query
export async function queryMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const first = await memory.query({ limit: 20, orderBy: [{ field: "id", direction: "asc" }] });
  if (first.status !== "success" || !first.output) throw new Error(first.error?.code ?? first.status);
  const items = [...first.output.items];
  if (first.output.nextCursor) {
    const next = await memory.query({ limit: 20, orderBy: [{ field: "id", direction: "asc" }], cursor: first.output.nextCursor });
    if (next.status !== "success" || !next.output) throw new Error(next.error?.code ?? next.status);
    items.push(...next.output.items);
  }
  return items;
}

// example: search
export async function searchMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.search({ query: "preferred language", limit: 5 });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(hit => ({ id: hit.memory.id, content: hit.memory.content, score: hit.score }));
}

// example: write
export async function writeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.write({ memories: [{ key: "preference", content: { language: "zh-CN" }, metadata: { source: "user" } }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!.id; // Allocated by the storage plugin.
}

// example: update
export async function updateMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.update({ memories: [{ id, content: { language: "en" }, metadata: {} }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!; // metadata is replaced, not merged; key is unchanged.
}

// example: delete
export async function deleteMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.delete({ ids: [id, id] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.deleted; // A missing id is not reported as deleted.
}

// example: execute
export async function executeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  return memory.execute("MEMORY.QUERY", { limit: 10 });
}

// example: plugin
export function adaptDatabase(database: MemoryStore & Partial<MemorySearchProvider>): MemoryResources {
  // These methods are the application's SDK adapter, not raw SQL/Milvus SDK methods.
  // Explicit calls retain the SDK adapter's receiver and connection pool.
  const store: MemoryStore = {
    get: input => database.get(input),
    query: input => database.query(input),
    write: input => database.write(input),
    update: input => database.update(input),
    delete: input => database.delete(input),
  };
  const search = database.search ? { search: (input: Parameters<MemorySearchProvider["search"]>[0]) => database.search!(input) } : undefined;
  return { store, ...(search ? { search } : {}) };
}

// example: errors
export async function memoryErrors(store: MemoryStore) {
  const search: MemorySearchProvider = {
    async search(input) {
      if (input.strategy !== "keyword") throw new MemoryError("UNSUPPORTED_STRATEGY", "Only keyword search is supported");
      throw new MemoryError("SEARCH_UNAVAILABLE", "Search is temporarily unavailable");
    },
  };
  const memory = createMemory({ store, search });
  const invalid = await memory.query({ limit: 0 }); // failed / INVALID_INPUT; store.query is not called.
  const unavailable = await memory.search({ query: "x", strategy: "keyword" });
  return { invalid, unavailable };
}

// example: graph
export async function memoryGraph(resources: MemoryResources) {
  const runtime = createDitto({ workers: [createMemoryWorker(resources)] });
  const plan = graph<string>("read-memory")
    .node("memory", "MEMORY.GET", [], id => ({ ids: [id] }));
  try { return await runtime.run(plan, "m1"); }
  finally { await runtime.close(); } // Close the application's database pool afterwards.
}

// example: scaffold
export const customGet = memoryGetNode.define("MEMORY", async () => ({
  executionId: "example-call", node: "MEMORY.GET", status: "failed",
  error: { code: "NOT_CONFIGURED", message: "Configure the application storage adapter" },
}));
