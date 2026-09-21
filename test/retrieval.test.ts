import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import * as core from "../src/index.js";
import {
  createDitto, createMemoryWorker, createHttpTransport, createWorkerHttpHandler,
  loadRuntimeConfig, NoWorkerAvailableError, type MemoryStore,
} from "../src/index.js";
import {
  createRetrieval, createRetrievalWorker, RetrievalTargetRegistry, RetrievalError,
  type RetrievalSearchInput, type RetrievalSearchProvider, type RetrievalSearchOutput,
} from "../src/worker/retrieval/index.js";
import { RemoteRetrievalSearchProvider } from "../src/worker/retrieval/adapters/memory.js";

function fixture() {
  const calls: RetrievalSearchInput[] = [];
  const provider: RetrievalSearchProvider = {
    async search(input) {
      calls.push(input);
      return { target: input.target, candidates: [{ id: "m1", content: input.query.content, score: 0.9,
        source: { target: input.target.name, ref: "memory:m1" }, metadata: { origin: "fixture" } }], metadata: { hits: 1 } };
    },
  };
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "vector", providers: { vector: provider, bm25: provider } } });
  return { calls, provider, providers };
}
const request: RetrievalSearchInput = { target: { name: "kb" }, query: { content: "hello" } };
const store: MemoryStore = {
  get: async () => [], query: async () => ({ items: [] }), write: async () => [], update: async () => [], delete: async () => ({ deleted: [] }),
};

test("RETRIEVAL is explicit opt-in; a local MEMORY provider needs no retrieval registration", async () => {
  assert.equal("createRetrievalWorker" in core, false);
  const runtime = createDitto({ workers: [createMemoryWorker({ store, search: {
    search: async input => [{ memory: { id: "local", content: input.query } }],
  } })] });
  try {
    assert.equal(runtime.workers().length, 1);
    assert.equal((await runtime.invoke("MEMORY.SEARCH", { query: "hello" })).output?.[0]?.memory.id, "local");
    await assert.rejects(runtime.invoke("RETRIEVAL.SEARCH", request), NoWorkerAvailableError);
  } finally { await runtime.close(); }
});

test("target registry selects strategies, preserves provider data, and snapshots startup bindings", async () => {
  const { calls, provider } = fixture();
  const bindings = { kb: { defaultStrategy: "vector", providers: { vector: provider, bm25: provider } } };
  const retrieval = createRetrieval({ providers: new RetrievalTargetRegistry(bindings) });
  bindings.kb.defaultStrategy = "missing";
  const input = { ...request, target: { name: "kb", namespace: "tenant-a", type: "knowledge", metadata: { revision: 2 } },
    query: { content: [0.2, 0.4], metadata: { model: "external" } }, filter: { tag: "a" }, options: { metric: "IP" } };
  const result = await retrieval.search(input);
  assert.equal(result.status, "success");
  assert.equal(result.node, "RETRIEVAL.SEARCH");
  assert.equal(result.output?.strategy, "vector");
  assert.deepEqual(result.output?.target, input.target);
  assert.deepEqual(result.output?.metadata, { hits: 1 });
  assert.deepEqual(result.output?.candidates[0], { id: "m1", content: [0.2, 0.4], score: 0.9,
    source: { target: "kb", ref: "memory:m1" }, metadata: { origin: "fixture" } });
  assert.deepEqual(calls[0], { ...input, strategy: "vector", limit: 10 });
  assert.equal(Object.hasOwn(input, "limit"), false);
  assert.equal((await retrieval.search({ ...request, strategy: "bm25" })).output?.strategy, "bm25");
  assert.equal((await retrieval.search({ ...request, strategy: "unknown" })).error?.code, "RETRIEVAL_STRATEGY_UNSUPPORTED");
  assert.equal((await retrieval.search({ ...request, target: { name: "unknown" } })).error?.code, "RETRIEVAL_TARGET_NOT_FOUND");
  assert.equal((await retrieval.search({ ...request, target: { name: "__proto__" } })).error?.code, "RETRIEVAL_TARGET_NOT_FOUND");
  assert.equal(calls.length, 2);
});

test("request validation precedes resolution; YAML and per-worker defaults remain independent", async () => {
  const { calls, providers } = fixture();
  const defaults = { searchLimit: 3 };
  const definition = createRetrievalWorker({ providers, defaults }); defaults.searchLimit = 88;
  const config = loadRuntimeConfig({}, { workers: { retrieval: { searchLimit: 2 } } });
  const runtime = createDitto({ config, workers: [definition] });
  try {
    await runtime.invoke("RETRIEVAL.SEARCH", request);
    await runtime.invoke("RETRIEVAL.SEARCH", { ...request, limit: 1 });
    assert.deepEqual(calls.map(call => call.limit), [3, 1]);
    const retrieval = createRetrieval({ providers });
    await retrieval.search(request, config.retrieval);
    assert.equal(calls[2]?.limit, 2);
    for (const input of [null, [], {}, { ...request, target: {} }, { ...request, query: {} },
      { ...request, limit: null }, { ...request, limit: 10001 }, { ...request, limit: 1.1 },
      { ...request, filter: [] }, { ...request, options: "bad" }, { ...request, target: { name: " " } }]) {
      assert.equal((await retrieval.search(input as never)).error?.code, "RETRIEVAL_INVALID_INPUT");
    }
    assert.equal((await retrieval.search({ ...request, strategy: "rag" })).error?.code, "RETRIEVAL_STRATEGY_UNSUPPORTED");
    assert.equal((await retrieval.search({ ...request, strategy: "RAG" })).error?.code, "RETRIEVAL_STRATEGY_UNSUPPORTED");
    assert.equal(calls.length, 3);
    assert.throws(() => loadRuntimeConfig({}, { workers: { retrieval: { searchLimit: 0 } } }));
    assert.throws(() => createRetrieval({ providers, defaults: { searchLimit: 0 } }));
    assert.throws(() => new RetrievalTargetRegistry({ kb: { defaultStrategy: "missing", providers: {} } }));
  } finally { await runtime.close(); }
});

test("custom registries handle authorization; backend errors and output errors stay sanitized", async () => {
  const denied = createRetrieval({ providers: { resolve: () => { throw new RetrievalError("RETRIEVAL_PERMISSION_DENIED", "Denied"); } } });
  assert.equal((await denied.search(request)).error?.code, "RETRIEVAL_PERMISSION_DENIED");
  const broken = createRetrieval({ providers: { resolve: () => ({ search: async () => { throw new Error("token=secret db://private"); } }) } });
  const result = await broken.search(request);
  assert.equal(result.error?.code, "RETRIEVAL_BACKEND_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  const timedOut = createRetrieval({ providers: { resolve: () => ({ search: async () => { throw new RetrievalError("RETRIEVAL_TIMEOUT", "Backend deadline exceeded"); } }) } });
  assert.equal((await timedOut.search(request)).status, "timeout");
  const unavailable = createRetrieval({ providers: { resolve: () => undefined as never } });
  assert.equal((await unavailable.search(request)).error?.code, "RETRIEVAL_PROVIDER_UNAVAILABLE");
  const malformed = [null, { target: request.target, candidates: [{}] }, { target: { name: "other" }, candidates: [] },
    { target: request.target, candidates: [{ content: "x", score: Infinity }] },
    { target: request.target, candidates: [{ content: "x", source: { ref: 123 } }] },
    { target: request.target, candidates: [{ content: 1 }, { content: 2 }] },
    { target: request.target, strategy: "wrong", candidates: [] }];
  for (const output of malformed) {
    const retrieval = createRetrieval({ providers: { resolve: () => ({ search: async () => output as never }) } });
    assert.equal((await retrieval.search({ ...request, limit: 1, strategy: "vector" })).error?.code, "RETRIEVAL_INVALID_BACKEND_OUTPUT");
  }
});

test("candidate IDs are optional, rank order and uncalibrated scores are not rewritten", async () => {
  const candidates = [{ content: { doc: "a" }, score: -3 }, { content: "b", score: 12 }];
  const retrieval = createRetrieval({ providers: { resolve: () => ({ search: async input => ({ target: input.target, candidates }) }) } });
  assert.deepEqual((await retrieval.search(request)).output?.candidates, candidates);
});

test("replicas share the public capability, enforce capacity and drain accepted work on close", async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const releases: (() => void)[] = []; const seen: string[] = [];
  const runtime = createDitto();
  for (const name of ["one", "two"]) {
    runtime.register(createRetrievalWorker({ concurrency: 1, providers: { resolve: () => ({ search: async input => {
      seen.push(name);
      await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) started(); });
      return { target: input.target, candidates: [{ content: name }] };
    } }) } }));
  }
  const first = runtime.invoke("RETRIEVAL.SEARCH", request);
  const second = runtime.invoke("RETRIEVAL.SEARCH", request);
  await ready;
  await assert.rejects(runtime.invoke("RETRIEVAL.SEARCH", request), NoWorkerAvailableError);
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  releases.forEach(release => release());
  const results = await Promise.all([first, second]); await closing;
  assert.deepEqual(seen.sort(), ["one", "two"]);
  assert.ok(results.every(result => result.status === "success"));
  assert.notEqual(results[0]!.executionId, results[1]!.executionId);
});

test("MEMORY can delegate via real HTTP to optional RETRIEVAL with an explicit batch mapper", async () => {
  const { providers, calls } = fixture();
  const remote = createDitto({ workers: [createRetrievalWorker({ providers })] });
  const server = createServer(createWorkerHttpHandler(remote, { token: "retrieval-test" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const runtime = createDitto({ transports: [createHttpTransport({ id: "retrieval", token: "retrieval-test", url: `http://127.0.0.1:${port}/ditto/invoke` })] });
  const worker = remote.workers()[0]!;
  runtime.registerRemote({ address: worker.address, capabilities: worker.capabilities, transportId: "retrieval" });
  let mapped: RetrievalSearchOutput | undefined;
  const search = new RemoteRetrievalSearchProvider({ runtime, target: { name: "kb" }, mapOutput: async output => {
    mapped = output;
    return output.candidates.map(candidate => ({ memory: { id: candidate.id!, content: candidate.content },
      ...(candidate.score === undefined ? {} : { score: candidate.score }), metadata: { source: candidate.source } }));
  } });
  runtime.register(createMemoryWorker({ store, search }));
  try {
    const input = { query: { vector: [1, 0] }, strategy: "vector", filter: { tenant: "a" }, limit: 4, options: { ef: 16 } };
    const result = await runtime.invoke("MEMORY.SEARCH", input);
    assert.equal(result.status, "success");
    assert.deepEqual(result.output?.[0]?.memory, { id: "m1", content: input.query });
    assert.deepEqual(calls[0], { query: { content: input.query }, target: { name: "kb" }, strategy: "vector", filter: input.filter, limit: 4, options: input.options });
    assert.equal(mapped?.candidates[0]?.source?.ref, "memory:m1");
    mapped = undefined;
    const failed = await runtime.invoke("MEMORY.SEARCH", { query: "x", strategy: "unknown" });
    assert.equal(failed.status, "failed"); assert.equal(mapped, undefined);
  } finally { await runtime.close(); await remote.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test("the optional MEMORY bridge sanitizes transport failure and never maps failed results", async () => {
  let mapped = false;
  const provider = new RemoteRetrievalSearchProvider({
    runtime: { invoke: async () => { throw new Error("connection=secret"); } },
    target: { name: "kb" }, mapOutput: () => { mapped = true; return []; },
  });
  await assert.rejects(provider.search({ query: "x" }), error => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.code, "RETRIEVAL_BACKEND_ERROR");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(mapped, false);
});
