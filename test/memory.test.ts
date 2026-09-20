import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createDitto, createMemory, createMemoryWorker, MemoryError, loadRuntimeConfig,
  createHttpTransport, createWorkerHttpHandler, runRagFlow, defineWorker,
  type MemoryItem, type MemoryStore, type MemorySearchProvider,
} from "../src/index.js";

// Test-only plugin. Core ships no database implementation or lifecycle manager.
function fixture() {
  const rows = new Map<string, MemoryItem>();
  const calls: { operation: string; input: unknown }[] = [];
  let serial = 0;
  const backend: MemoryStore & MemorySearchProvider = {
    async get(input) {
      calls.push({ operation: "get", input });
      return [...rows.values()].filter(row => input.ids?.includes(row.id) || (row.key && input.keys?.includes(row.key))).reverse();
    },
    async query(input) { calls.push({ operation: "query", input }); return { items: [...rows.values()].slice(0, input.limit) }; },
    async search(input) { calls.push({ operation: "search", input }); return [...rows.values()].slice(0, input.limit).map(memory => ({ memory, score: 0.9 })); },
    async write(input) {
      calls.push({ operation: "write", input });
      const items = input.memories.map(draft => ({ ...draft, id: String(++serial) }));
      items.forEach(item => rows.set(item.id, item)); return items;
    },
    async update(input) {
      calls.push({ operation: "update", input });
      if (input.memories.some(entry => !rows.has(entry.id))) throw new MemoryError("NOT_FOUND", "Update target does not exist");
      const items = input.memories.map(entry => ({ ...rows.get(entry.id)!, ...entry }));
      items.forEach(item => rows.set(item.id, item)); return items;
    },
    async delete(input) { calls.push({ operation: "delete", input }); return { deleted: input.ids.filter(id => rows.delete(id)) }; },
  };
  return { backend, rows, calls };
}

test("one injected plugin independently supplies storage and search; CRUD preserves identity", async () => {
  const { backend, calls } = fixture();
  const memory = createMemory({ store: backend, search: backend });
  const written = await memory.write({ memories: [
    { key: "a", content: { text: "first", vector: [1, 0] }, metadata: { old: true } },
    { key: "b", content: "second" },
  ] });
  assert.equal(written.status, "success");
  assert.equal(written.node, "MEMORY.WRITE");
  const [a, b] = written.output!;
  const got = await memory.get({ ids: [a!.id, a!.id, "missing"], keys: ["b", "a", "b"] });
  assert.deepEqual(got.output, [a, b]);
  assert.deepEqual(calls.at(-1)?.input, { ids: [a!.id, "missing"], keys: ["b", "a"] });
  const updated = await memory.update({ memories: [{ id: a!.id, metadata: { revision: 2 } }] });
  assert.deepEqual(updated.output, [{ ...a, metadata: { revision: 2 } }]);
  assert.equal((await memory.update({ memories: [{ id: "missing", content: null }] })).error?.code, "NOT_FOUND");
  assert.equal((await memory.search({ query: [1, 0], strategy: "vector" })).output?.[0]?.memory.id, a!.id);
  assert.deepEqual((await memory.delete({ ids: [a!.id, a!.id, "missing"] })).output, { deleted: [a!.id] });
  assert.deepEqual((await memory.delete({ ids: [a!.id] })).output, { deleted: [] });
  assert.notEqual(written.executionId, got.executionId);
});

test("storage and search are independently replaceable; backend-specific requests pass through", async () => {
  const store = fixture(); const index = fixture();
  await index.backend.write({ memories: [{ content: "external corpus" }] });
  const memory = createMemory({ store: store.backend, search: index.backend });
  const search = { query: { vector: [0.1, 0.2] }, strategy: "hybrid", filter: { tenant: "t1" }, options: { alpha: 0.7 }, limit: 2 };
  assert.equal((await memory.search(search)).output?.[0]?.memory.content, "external corpus");
  assert.deepEqual(index.calls.at(-1)?.input, search);
  assert.equal(store.calls.length, 0);
  const query = { filter: { state: "active" }, cursor: "opaque:token", orderBy: [{ field: "created_at", direction: "desc" as const }], limit: 5 };
  await memory.query(query);
  assert.deepEqual(store.calls.at(-1)?.input, query);
  assert.deepEqual(index.calls.map(call => call.operation), ["write", "search"]);
});

test("empty operations are local no-ops, malformed inputs never reach a plugin", async () => {
  const { backend, calls } = fixture(); const memory = createMemory({ store: backend, search: backend });
  assert.deepEqual((await memory.get({ ids: [] })).output, []);
  assert.deepEqual((await memory.write({ memories: [] })).output, []);
  assert.deepEqual((await memory.update({ memories: [] })).output, []);
  assert.deepEqual((await memory.delete({ ids: [] })).output, { deleted: [] });
  const invalid: [string, unknown][] = [
    ["GET", {}], ["GET", { ids: [""] }], ["GET", null], ["QUERY", []], ["QUERY", { limit: 0 }],
    ["QUERY", { orderBy: [{ field: "id", direction: "sideways" }] }], ["SEARCH", {}], ["SEARCH", { query: "x", limit: null }],
    ["WRITE", { memories: [{}] }], ["WRITE", { memories: [{ content: null, metadata: [] }] }],
    ["UPDATE", { memories: [{ id: "a" }] }], ["UPDATE", { memories: [{ id: "a", content: 1, key: "new" }] }],
    ["UPDATE", { memories: [{ id: "a", content: 1 }, { id: "a", content: 2 }] }], ["DELETE", { ids: [1] }],
  ];
  for (const [op, input] of invalid) {
    const result = await memory.execute(`MEMORY.${op}` as "MEMORY.GET", input as never);
    assert.equal(result.error?.code, "INVALID_INPUT", op);
  }
  assert.equal(calls.length, 0);
});

test("backend failures and malformed responses are safe NodeResults", async () => {
  const { backend } = fixture();
  const broken = createMemory({ store: { ...backend, query: async () => { throw new Error("password=secret"); } }, search: backend });
  const failed = await broken.query({});
  assert.equal(failed.error?.code, "MEMORY_BACKEND_ERROR");
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  for (const output of [{ items: [{}] }, { items: [{ id: "x", content: 1 }, { id: "x", content: 2 }] }]) {
    const memory = createMemory({ store: { ...backend, query: async () => output as never }, search: backend });
    assert.equal((await memory.query({})).error?.code, "INVALID_BACKEND_OUTPUT");
  }
  const incomplete = createMemory({ store: { ...backend, update: async () => [], delete: async () => ({ deleted: ["unrequested"] }) }, search: backend });
  assert.equal((await incomplete.update({ memories: [{ id: "x", content: 1 }] })).error?.code, "INVALID_BACKEND_OUTPUT");
  assert.equal((await incomplete.delete({ ids: ["x"] })).error?.code, "INVALID_BACKEND_OUTPUT");
  const badSearch = createMemory({ store: backend, search: { search: async () => [{ memory: { id: "x", content: null }, score: NaN }] } });
  assert.equal((await badSearch.search({ query: null })).error?.code, "INVALID_BACKEND_OUTPUT");
});

test("YAML defaults, explicit overrides and concurrent requests remain independent", async () => {
  const { backend, calls } = fixture(); const defaults = { queryLimit: 4 };
  const runtime = createDitto({ config: loadRuntimeConfig({}, { workers: { memory: { queryLimit: 3, searchLimit: 2 } } }),
    workers: [createMemoryWorker({ store: backend, search: backend, defaults })] });
  try {
    await runtime.invoke("MEMORY.QUERY", {});
    defaults.queryLimit = 99;
    await Promise.all([runtime.invoke("MEMORY.SEARCH", { query: "x" }), runtime.invoke("MEMORY.QUERY", { limit: 7 }), runtime.invoke("MEMORY.QUERY", {})]);
    assert.deepEqual(calls.map(call => (call.input as { limit: number }).limit), [4, 2, 7, 4]);
    assert.throws(() => loadRuntimeConfig({}, { workers: { memory: { queryLimit: 0 } } }));
    assert.throws(() => createMemory({ store: backend, search: backend, defaults: { searchLimit: 1.5 } }));
  } finally { await runtime.close(); }
});

test("MEMORY nodes execute through the existing HTTP transport", async () => {
  const { backend } = fixture();
  const serverRuntime = createDitto({ workers: [createMemoryWorker({ store: backend, search: backend })] });
  const server = createServer(createWorkerHttpHandler(serverRuntime, { token: "test-token" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const client = createDitto({ transports: [createHttpTransport({ id: "http", url: `http://127.0.0.1:${port}/ditto/invoke`, token: "test-token" })] });
  const worker = serverRuntime.workers()[0]!;
  client.registerRemote({ address: worker.address, capabilities: worker.capabilities, transportId: "http" });
  try {
    const result = await client.invoke("MEMORY.WRITE", { memories: [{ content: { text: "remote" } }] });
    assert.equal(result.status, "success");
    assert.deepEqual((await client.invoke("MEMORY.GET", { ids: [result.output![0]!.id] })).output, result.output);
    assert.equal((await client.invoke("MEMORY.SEARCH", { query: "remote" })).output?.length, 1);
  } finally { await client.close(); await serverRuntime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("memory flow uses an explicit Context mapping and stops on search failure", async () => {
  let updates = 0;
  const runtime = createDitto({ workers: [
    defineWorker({ type: "MEMORY", nodes: { "MEMORY.SEARCH": async () => ({ executionId: "x", node: "MEMORY.SEARCH", status: "failed", error: { code: "UNAVAILABLE", message: "Unavailable" } }) } }),
    defineWorker({ type: "CONTEXT", nodes: { "CONTEXT.UPDATE": async ({ context }) => { updates++; return context; } } }),
  ] });
  try {
    await assert.rejects(runRagFlow(runtime, { scope: "memory", context: { items: [] }, query: [1, 2], mapMemory: ({ memory }) => ({ id: memory.id, sourceNode: "MEMORY.SEARCH", content: String(memory.content) }) }), /UNAVAILABLE/);
    assert.equal(updates, 0);
  } finally { await runtime.close(); }
});
