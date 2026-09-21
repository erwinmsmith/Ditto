import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { createDitto, createMemory, createMemoryWorker, loadRuntimeConfig, loadRuntimeConfigFile, type MemoryStore } from "../src/index.js";
import {
  createRetrieval, createRetrievalWorker, RetrievalTargetRegistry, createVectorSearchProvider, createTextSearchProvider,
  createHybridSearchProvider, createRerankSearchProvider, createCosineReranker, rerankCandidates, embedContents,
  createHttpEmbeddingProvider, embeddingConfigFromEnv, createSqlSearchProvider, createMilvusSearchProvider,
  type EmbeddingProvider, type RetrievalSearchInput, type RetrievalSearchProvider, type RetrievalCandidate,
} from "../src/worker/retrieval/index.js";
import { createMemoryRetrievalProvider, createRetrievalMemorySearchProvider, RemoteRetrievalSearchProvider, mapMemoryCandidates } from "../src/worker/retrieval/adapters/memory.js";

const request: RetrievalSearchInput = { target: { name: "memories" }, query: { content: "memory" }, limit: 2 };
const candidate = (id: string, score = 1): RetrievalCandidate => ({ id, content: id, score, source: { target: "memories", ref: id }, metadata: { original: id } });
const fixed = (candidates: RetrievalCandidate[]): RetrievalSearchProvider => ({ async search(input) {
  return { target: input.target, candidates: candidates.slice(0, input.limit), metadata: { backend: true } };
} });
const registry = (provider: RetrievalSearchProvider) => new RetrievalTargetRegistry({ memories: { defaultStrategy: "hybrid", providers: { hybrid: provider } } });

test("embedding batches preserve order, dimensions and purpose; malformed vectors and cancellations fail", async () => {
  const batches: unknown[][] = [];
  const embedding: EmbeddingProvider = { async embed(input) {
    assert.equal(input.purpose, "document"); batches.push([...input.contents]);
    return input.contents.map(value => [Number(value), 1]);
  } };
  assert.deepEqual(await embedContents(embedding, { contents: [1, 2, 3], purpose: "document" }, { batchSize: 2 }), [[1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(batches, [[1, 2], [3]]);
  assert.deepEqual(await embedContents(embedding, { contents: [], purpose: "query" }), []);
  assert.equal(batches.length, 2);
  for (const vectors of [[], [[NaN]], [[]], [[1], [1, 2]]]) {
    await assert.rejects(embedContents({ embed: async () => vectors }, { contents: ["a", "b"], purpose: "query" }), { code: "RETRIEVAL_INVALID_EMBEDDING" });
  }
  let index = 0;
  await assert.rejects(embedContents({ embed: async () => [++index === 1 ? [1] : [1, 2]] }, { contents: [1, 2], purpose: "document" }, { batchSize: 1 }), { code: "RETRIEVAL_INVALID_EMBEDDING" });
  await assert.rejects(embedContents(embedding, { contents: [], purpose: "query" }, {}, { signal: AbortSignal.abort() }));
});

test("vector retrieval selects external, precomputed or native embedding and preserves scope", async () => {
  let embeds = 0;
  const calls: RetrievalSearchInput[] = [];
  const backend: RetrievalSearchProvider = { async search(input) { calls.push(input); return { target: input.target, candidates: [] }; } };
  const provider = createVectorSearchProvider({ backend, embedding: { async embed() { embeds++; return [[1, 2]]; } }, dimensions: 2 });
  const input = { ...request, query: { content: "memory", metadata: { locale: "zh" } }, filter: { tenant: "a" }, options: { ef: 32 } };
  await provider.search(input);
  assert.deepEqual(calls[0], { ...input, query: { ...input.query, content: [1, 2] } });
  await provider.search({ ...input, query: { content: [0, 1] } });
  assert.equal(embeds, 1);
  await assert.rejects(provider.search({ ...input, query: { content: [0] } }), { code: "RETRIEVAL_INVALID_EMBEDDING" });
  await assert.rejects(provider.search({ ...input, query: { content: [] } }), { code: "RETRIEVAL_INVALID_EMBEDDING" });
  await createVectorSearchProvider({ backend, nativeEmbedding: true }).search(input);
  assert.equal(calls[2]?.query.content, "memory");
  await assert.rejects(createVectorSearchProvider({ backend }).search(input), { code: "RETRIEVAL_INVALID_INPUT" });
  assert.throws(() => createVectorSearchProvider({ backend, nativeEmbedding: true, embedding: { embed: async () => [] } }));
});

test("weighted RRF uses ranks across raw score scales, counts each branch once and retains provenance", async () => {
  const hybrid = createHybridSearchProvider({ rrfK: 1, branches: [
    { strategy: "vector", provider: fixed([candidate("a", 0.99), candidate("a", 0.98), candidate("b", 0.1)]) },
    { strategy: "bm25", weight: 2, provider: fixed([candidate("b", 900), candidate("a", 20)]) },
  ] });
  const output = await hybrid.search({ ...request, strategy: "hybrid" });
  assert.deepEqual(output.candidates.map(c => c.id), ["b", "a"]);
  assert.equal(output.candidates[0]?.score, 1 / 4 + 2 / 2);
  assert.equal(output.candidates[1]?.score, 1 / 2 + 2 / 3);
  assert.equal(output.candidates[0]?.source?.ref, "b");
  const fusion = output.metadata!.fusion as { contributions: Record<string, { score: number; weight: number; metadata: unknown }[]> };
  assert.deepEqual(fusion.contributions['["memories","b"]']?.map(c => [c.score, c.weight]), [[0.1, 1], [900, 2]]);
  assert.deepEqual(fusion.contributions['["memories","b"]']?.[0]?.metadata, { original: "b" });
  await assert.rejects(createHybridSearchProvider({ branches: [{ strategy: "custom", provider: fixed([{ content: "no id" }]) }] }).search(request));
  const explicit = createHybridSearchProvider({ key: c => String(c.content), branches: [{ strategy: "custom", provider: fixed([{ content: "id" }]) }] });
  assert.equal((await explicit.search(request)).candidates.length, 1);
});

test("hybrid drains accepted branches on failure instead of releasing capacity with work still running", async () => {
  let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let completed = false;
  const hybrid = createHybridSearchProvider({ branches: [
    { strategy: "bad", provider: { async search() { throw new Error("private"); } } },
    { strategy: "slow", provider: { async search(input) { started(); await gate; completed = true; return { target: input.target, candidates: [] }; } } },
  ] });
  let settled = false;
  const operation = createRetrieval({ providers: registry(hybrid) }).search(request).then(result => { settled = true; return result; });
  await entered;
  assert.equal(settled, false); finish();
  const result = await operation;
  assert.equal(completed, true); assert.equal(result.error?.code, "RETRIEVAL_BACKEND_ERROR");
  assert.doesNotMatch(result.error!.message, /private/);
});

test("rerank maps original candidates, rejects invented/duplicate indexes and supports cosine ranking", async () => {
  const candidates = [candidate("a"), candidate("b"), candidate("c")];
  const input = { query: request.query, candidates, limit: 2 };
  assert.deepEqual((await rerankCandidates({ rank: async () => [{ index: 2 }, { index: 0 }] }, input)), [candidates[2], candidates[0]]);
  for (const order of [[{ index: 0 }, { index: 0 }], [{ index: 4 }, { index: 0 }], [{ index: 0 }], [{ index: 0, score: NaN }, { index: 1 }]]) {
    await assert.rejects(rerankCandidates({ rank: async () => order }, input), { code: "RETRIEVAL_INVALID_BACKEND_OUTPUT" });
  }
  const embedding: EmbeddingProvider = { async embed(input) { return input.contents.map(value => value === "a" ? [-1, 0] : value === "c" ? [0, 1] : [1, 0]); } };
  const rerank = createRerankSearchProvider({ search: fixed(candidates), reranker: createCosineReranker(embedding), candidateLimit: 3 });
  const output = await rerank.search(request);
  assert.deepEqual(output.candidates.map(c => [c.id, c.score]), [["b", 1], ["c", 0]]);
  assert.deepEqual(output.metadata, { backend: true });
  let called = false;
  assert.deepEqual(await rerankCandidates({ async rank() { called = true; return []; } }, { ...input, candidates: [] }), []);
  assert.equal(called, false);
});

test("SQL adapter executes real parameterized SQLite FTS5/BM25 with namespace isolation", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE memories USING fts5(id UNINDEXED, tenant UNINDEXED, content)");
    const insert = db.prepare("INSERT INTO memories VALUES (?, ?, ?)");
    insert.run("1", "a", "memory memory memory migration"); insert.run("2", "a", "memory operations"); insert.run("3", "b", "memory secret");
    const provider = createTextSearchProvider(createSqlSearchProvider({
      prepare: input => ({ text: "SELECT id, content, bm25(memories) AS rank FROM memories WHERE memories MATCH ? AND tenant = ? ORDER BY rank LIMIT ?",
        values: [input.query.content, input.target.namespace, input.limit] }),
      query: async statement => db.prepare(statement.text).all(...statement.values as SQLInputValue[]),
      mapRow: row => ({ id: String(row.id), content: row.content, score: -Number(row.rank), source: { target: "memories", ref: String(row.id) } }),
    }));
    const output = await provider.search({ ...request, target: { name: "memories", namespace: "a" }, strategy: "bm25" });
    assert.deepEqual(output.candidates.map(c => c.id), ["1", "2"]);
    assert.ok(output.candidates[0]!.score! > output.candidates[1]!.score!);
    assert.deepEqual((await provider.search({ ...request, target: { name: "memories", namespace: "a' OR 1=1 --" } })).candidates, []);
    await assert.rejects(provider.search({ ...request, query: { content: [1] } }), { code: "RETRIEVAL_INVALID_INPUT" });
  } finally { db.close(); }
});

test("Milvus adapter maps native search protocol, scopes queries and rejects backend failures", async () => {
  const memory = { id: "m1", key: "stable-key", content: "memory", metadata: { tenant: "a" } };
  let received: unknown;
  const provider = createMilvusSearchProvider({ collection: "stored_memories", vectorField: "vector", outputFields: ["memory"],
    scope: input => ({ filter: "tenant == {tenant}", exprValues: { tenant: input.target.namespace } }),
    search: async query => { received = query; return { status: { error_code: "Success", code: 0 }, results: [{ id: "m1", score: 0.9, memory }] }; },
    mapHit: hit => ({ id: hit.id, content: hit.memory, score: hit.score }), params: { ef: 64 },
  });
  const output = await createVectorSearchProvider({ backend: provider, embedding: { embed: async () => [[1, 0]] } }).search({ ...request, target: { name: "memories", namespace: "a" }, options: { collection_name: "forged" } });
  assert.deepEqual(received, { collection_name: "stored_memories", anns_field: "vector", data: [[1, 0]], output_fields: ["memory"], limit: 2,
    filter: "tenant == {tenant}", exprValues: { tenant: "a" }, params: { ef: 64 } });
  assert.deepEqual(mapMemoryCandidates(output)[0]?.memory, memory);
  const failing = createMilvusSearchProvider({ collection: "c", vectorField: "v", outputFields: [], search: async () => ({ status: { code: 7, reason: "secret" }, results: [] }), mapHit: () => candidate("never") });
  await assert.rejects(failing.search(request), { code: "RETRIEVAL_BACKEND_ERROR", message: "Milvus search failed" });
  await assert.rejects(failing.search({ ...request, filter: { tenant: "a" } }), { code: "RETRIEVAL_INVALID_INPUT" });
  await createVectorSearchProvider({ backend: provider, nativeEmbedding: true }).search(request);
  assert.deepEqual((received as { data: unknown[] }).data, ["memory"]);
});

test("same database search plugin supports local MEMORY and delegated RETRIEVAL without losing Memory fields", async () => {
  const memory = { id: "m1", key: "stable", content: "memory", metadata: { revision: 3 } };
  let embeds = 0;
  const database: MemoryStore & import("../src/worker/memory/providers/store.js").MemorySearchProvider = {
    get: async () => [memory], query: async () => ({ items: [memory] }), write: async () => [], update: async () => [], delete: async () => ({ deleted: [] }),
    search: async input => { assert.deepEqual(input.query, [1, 0]); assert.deepEqual(input.filter, { visible: true }); return [{ memory, score: 0.8, metadata: { match: "vector" } }]; },
  };
  const provider = createVectorSearchProvider({ backend: createMemoryRetrievalProvider(database), embedding: { async embed() { embeds++; return [[1, 0]]; } } });
  const local = createDitto({ workers: [createMemoryWorker({ store: database, search: createRetrievalMemorySearchProvider({ provider, target: request.target }) })] });
  const remote = createDitto({ workers: [createRetrievalWorker({ providers: registry(provider) })] });
  remote.register(createMemoryWorker({ store: database, search: new RemoteRetrievalSearchProvider({ runtime: remote, target: request.target }) }));
  try {
    const a = await local.invoke("MEMORY.SEARCH", { query: "memory", filter: { visible: true } });
    const b = await remote.invoke("MEMORY.SEARCH", { query: "memory", filter: { visible: true } });
    assert.equal(a.status, "success"); assert.equal(b.status, "success"); assert.deepEqual(a.output, b.output);
    assert.deepEqual(a.output?.[0]?.memory, memory); assert.equal(a.output?.[0]?.metadata?.match, "vector"); assert.equal(embeds, 2);
    assert.equal(local.workers().length, 1);
    assert.deepEqual((await remote.invoke("MEMORY.GET", { ids: ["m1"] })).output, [memory]);
    assert.throws(() => mapMemoryCandidates({ target: request.target, candidates: [candidate("m1")] }));
  } finally { await local.close(); await remote.close(); }
});

test("YAML drives nested provider defaults; graph strategies use their own backend without embedding", async () => {
  const defaults = loadRuntimeConfigFile("ditto.yaml", {}).retrieval;
  assert.equal(defaults.hybrid?.rrfK, 60); assert.equal(defaults.embedding?.batchSize, 64);
  for (const retrieval of [{ embedding: { batchSize: 0 } }, { hybrid: { rrfK: 0 } }, { rerank: { candidateLimit: 10001 } }]) {
    assert.throws(() => loadRuntimeConfig({}, { workers: { retrieval } }));
  }
  const pools: number[] = [];
  const backend: RetrievalSearchProvider = { async search(input, context) {
    pools.push(input.limit!); assert.equal(context?.defaults?.embedding?.batchSize, 2);
    return { target: input.target, candidates: [candidate("a")] };
  } };
  const provider = createHybridSearchProvider({ branches: [{ strategy: "graph", provider: backend }] });
  const runtime = createDitto({ config: loadRuntimeConfig({}, { workers: { retrieval: { embedding: { batchSize: 2 }, hybrid: { candidateLimit: 7, rrfK: 3 } } } }),
    workers: [createRetrievalWorker({ providers: registry(provider), defaults: { hybrid: { rrfK: 1 } } })] });
  try {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", request);
    assert.deepEqual(pools, [7]); assert.equal(result.output?.candidates[0]?.score, 0.5);
  } finally { await runtime.close(); }
  const cancelled = await createRetrieval({ providers: registry(provider) }).search(request, {}, { signal: AbortSignal.abort() });
  assert.equal(cancelled.status, "cancelled"); assert.deepEqual(pools, [7]);
});

test("HTTP embedding sends real wire requests, restores index order, enforces permission and sanitizes errors", async () => {
  let mode = "ok"; let calls = 0;
  const server = createServer(async (req, res) => {
    calls++; assert.equal(req.url, "/v1/embeddings"); assert.equal(req.headers.authorization, "Bearer fixture-key");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.model, "fixture"); assert.equal(input.encoding_format, "float");
    if (mode === "error") { res.writeHead(401).end("secret-key"); return; }
    if (mode === "delay") { setTimeout(() => res.end("{}"), 50); return; }
    const data = input.input.map((_: string, index: number) => ({ index: mode === "duplicate" ? 0 : index, embedding: [index + 1, 0] })).reverse();
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const config = embeddingConfigFromEnv({ DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`, DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL: "fixture", DITTO_WORKER_RETRIEVAL_EMBEDDING_API_KEY: "fixture-key" });
  const sandbox = { assert: () => {} };
  const provider = createHttpEmbeddingProvider({ ...config, sandbox });
  const input = { contents: ["a", "b"], purpose: "query" as const };
  try {
    assert.deepEqual(await embedContents(provider, input), [[1, 0], [2, 0]]);
    mode = "duplicate"; await assert.rejects(embedContents(provider, input), { code: "RETRIEVAL_INVALID_EMBEDDING" });
    mode = "error"; await assert.rejects(provider.embed(input), { code: "RETRIEVAL_BACKEND_ERROR", message: "Embedding provider returned HTTP 401" });
    const count = calls;
    await assert.rejects(createHttpEmbeddingProvider({ ...config, sandbox: { assert() { throw new Error("private-policy"); } } }).embed(input), { code: "RETRIEVAL_PERMISSION_DENIED" });
    assert.equal(calls, count);
    mode = "delay"; await assert.rejects(createHttpEmbeddingProvider({ ...config, sandbox, timeoutMs: 5 }).embed(input), { code: "RETRIEVAL_TIMEOUT" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("complete embedding → vector/full-text → fusion → rerank chain runs behind MEMORY", async () => {
  const records = [
    { id: "a", key: "stable-a", content: "memory storage", metadata: { topic: "agent" } },
    { id: "b", key: "stable-b", content: "retrieval compute", metadata: { topic: "search" } },
  ];
  const phases: string[] = [];
  const embedding: EmbeddingProvider = { async embed(input) { phases.push("embedding"); assert.deepEqual(input.contents, ["memory"]); return [[1, 0]]; } };
  const native = createMemoryRetrievalProvider({ async search(input) {
    phases.push("vector"); assert.deepEqual(input.query, [1, 0]); assert.equal(input.limit, 4);
    return records.map(memory => ({ memory, score: memory.id === "a" ? 0.9 : 0.1 }));
  } });
  const vector = createVectorSearchProvider({ backend: native, embedding });
  const keyword = createTextSearchProvider({ async search(input) {
    phases.push("text"); assert.equal(input.query.content, "memory"); assert.equal(input.limit, 4);
    return { target: input.target, candidates: [...records].reverse().map(memory => ({ id: memory.id, content: memory, score: 50 })) };
  } });
  const fusion = createHybridSearchProvider({ branches: [{ strategy: "vector", provider: vector }, { strategy: "keyword", provider: keyword }] });
  const pipeline = createRerankSearchProvider({ search: fusion, reranker: { async rank(input) {
    phases.push("rerank"); assert.equal(input.query.content, "memory"); assert.equal(input.candidates.length, 2);
    assert.ok(input.candidates.every(c => c.score! < 1));
    return [{ index: input.candidates.findIndex(c => c.id === "b"), score: 0.95 }];
  } } });
  const config = loadRuntimeConfig({}, { workers: { retrieval: { embedding: { batchSize: 2 }, hybrid: { candidateLimit: 4 }, rerank: { candidateLimit: 3 } } } });
  const runtime = createDitto({ config, workers: [createRetrievalWorker({ providers: registry(pipeline) })] });
  const search = new RemoteRetrievalSearchProvider({ runtime, target: request.target });
  try {
    const result = await search.search({ query: "memory", limit: 1 });
    assert.deepEqual(result[0]?.memory, records[1]); assert.equal(result[0]?.score, 0.95);
    assert.deepEqual(phases.sort(), ["embedding", "rerank", "text", "vector"]);
  } finally { await runtime.close(); }
});

test("invalid SDK tuning and sparse vectors are rejected before backend execution", async () => {
  const backend = fixed([]);
  assert.throws(() => createRetrieval({ providers: registry(backend), defaults: { hybrid: { rrfK: 0 } } }));
  assert.throws(() => createRetrievalMemorySearchProvider({ provider: backend, target: request.target, defaults: { embedding: { batchSize: 3000 } } }));
  await assert.rejects(createHybridSearchProvider({ branches: [{ strategy: "vector", provider: backend }], candidateLimit: 0 }).search(request));
  await assert.rejects(createRerankSearchProvider({ search: backend, reranker: { rank: async () => [] }, candidateLimit: 0 }).search(request));
  for (const vector of [[NaN], [Infinity], new Array<number>(2), []]) {
    await assert.rejects(embedContents({ embed: async () => [vector] }, { contents: ["query"], purpose: "query" }), { code: "RETRIEVAL_INVALID_EMBEDDING" });
  }
  await assert.rejects(rerankCandidates({ rank: async () => new Array(1) }, { query: request.query, candidates: [candidate("a")], limit: 1 }));
  const huge = createCosineReranker({ embed: async input => input.contents.map(() => [Number.MAX_VALUE, Number.MAX_VALUE]) });
  assert.ok(Math.abs((await huge.rank({ query: request.query, candidates: [candidate("a")], limit: 1 }))[0]!.score! - 1) < 1e-12);
});


test("MEMORY uses interchangeable cloud HTTP and local SDK embedding without a retrieval Worker", async () => {
  let localCalls = 0; let cloudCalls = 0; let databaseCalls = 0;
  const memory = { id: "m", content: "stored" };
  const store: MemoryStore = {
    get: async () => [memory], query: async () => ({ items: [memory] }),
    write: async () => [], update: async () => [], delete: async () => ({ deleted: [] }),
  };
  // A local model handle can own native resources and require its SDK receiver.
  const localModel = { async encode(contents: readonly unknown[]) {
    assert.equal(this, localModel); localCalls++; assert.deepEqual(contents, ["query"]); return [[1, 0]];
  } };
  const local: EmbeddingProvider = { embed: input => localModel.encode(input.contents) };
  const cloud = createHttpEmbeddingProvider({ baseUrl: "https://embedding.example/v1", model: "configured-model", apiKey: "test-only",
    sandbox: { assert(kind, origin) { assert.equal(kind, "network"); assert.equal(origin, "https://embedding.example"); } },
    fetch: async (url, init) => {
      cloudCalls++; assert.equal(url, "https://embedding.example/v1/embeddings");
      assert.deepEqual(JSON.parse(init!.body as string).input, ["query"]);
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    },
  });
  const database = createMemoryRetrievalProvider({ async search(input) {
    databaseCalls++; assert.deepEqual(input.query, [1, 0]); return [{ memory, score: 0.9 }];
  } });
  for (const embedding of [local, cloud]) {
    const provider = createVectorSearchProvider({ backend: database, embedding });
    const sdk = createMemory({ store, search: createRetrievalMemorySearchProvider({ provider, target: request.target }) });
    assert.deepEqual((await sdk.search({ query: "query" })).output?.[0]?.memory, memory);
    assert.deepEqual((await sdk.get({ ids: ["m"] })).output, [memory]);
  }
  assert.deepEqual([localCalls, cloudCalls, databaseCalls], [1, 1, 2]);
});
