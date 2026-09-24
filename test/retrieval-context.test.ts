import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  createContext, createContextWorker, createDitto, createHttpTransport, createWorkerHttpHandler,
  graph, type ContextSelectInput,
} from "../src/index.js";
import {
  createRetrievalWorker, createVectorSearchProvider, RetrievalTargetRegistry, type RetrievalSearchProvider,
} from "@codesoul-co/ditto-retrieval";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";
import { createRetrievalContextStrategy, mapContextCandidates } from "@codesoul-co/ditto-retrieval/adapters/context";

const input: ContextSelectInput = { context: { items: [] }, purpose: "infer", query: "question", limit: 3, strategy: { kind: "rag" } };
function pipeline() {
  let embedded = 0;
  const provider = createVectorSearchProvider({ dimensions: 2, embedding: { async embed(request) {
    embedded++; assert.deepEqual(request.contents, ["question"]); return [[1, 0]];
  } }, backend: { async search(request) {
    assert.deepEqual(request.query.content, [1, 0]);
    return { target: request.target, candidates: [
      { id: "first", content: "first evidence", score: 0.8, source: { ref: "urn:evidence:first" }, metadata: { kind: "manual" } },
      { id: "first", content: "duplicate", score: 0.7 },
      { id: "second", content: "second evidence", score: 0.6 },
    ] };
  } } });
  return { provider, embedded: () => embedded };
}

test("Context reuses an inline embedding/vector pipeline while enforcing Context deduplication and token budgets", async () => {
  const { provider, embedded } = pipeline();
  const target = { name: "docs", namespace: "tenant" };
  const strategy = createRetrievalContextStrategy({ provider, target });
  target.namespace = "changed";
  const sdk = createContext({ services: { ragStrategy: strategy, tokenEstimator: { estimate: () => 1 } } });
  const selected = await sdk.select({ ...input, maxTokens: 1 });
  assert.equal(selected.context.items.length, 1); assert.equal(embedded(), 1);
  const item = selected.context.items[0]!;
  assert.equal(item.content, "first evidence"); assert.equal(item.source?.uri, "urn:evidence:first");
  assert.equal(item.metadata?.score, 0.8); assert.equal(item.metadata?.kind, "manual");
  assert.equal(item.id, (await sdk.select(input)).context.items[0]!.id);
  assert.equal((await sdk.select(input)).context.items.length, 2);
});

test("Context delegates embedding/retrieval over real HTTP; accepted graphs finish during Runtime shutdown", async () => {
  const { provider, embedded } = pipeline();
  const worker = createDitto({ hostId: "search-host", processId: "search" });
  const handle = worker.register(createRetrievalWorker({ providers: new RetrievalTargetRegistry({ docs: {
    defaultStrategy: "vector", providers: { vector: provider },
  } }) }), "retrieval");
  const server = createServer(createWorkerHttpHandler(worker, { token: "fixture" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const transport = createHttpTransport({ id: "search", url: `http://127.0.0.1:${address.port}/ditto/invoke`, token: "fixture" });
  const runtime = createDitto({ hostId: "app", transports: [transport] });
  runtime.registerRemote({ address: handle.address, capabilities: ["RETRIEVAL.SEARCH"], transportId: transport.id });
  runtime.register(createContextWorker({ services: { ragStrategy: createRetrievalContextStrategy({ target: { name: "docs" } }) } }));
  try {
    const plan = graph<void>().node("select", "CONTEXT.SELECT", [], () => input);
    const result = runtime.run(plan, undefined);
    const closing = runtime.close();
    assert.equal((await result).select.context.items.length, 2); assert.equal(embedded(), 1);
    await closing;
  } finally {
    await runtime.close(); await worker.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("Context retrieval rejects unmapped corpus/invalid output and forwards cancellation to inline providers", async () => {
  let calls = 0;
  const controller = new AbortController();
  const provider: RetrievalSearchProvider = { async search(request, options) {
    calls++; assert.equal(options?.signal, controller.signal); controller.abort(new Error("stop context retrieval"));
    return { target: request.target, candidates: [] };
  } };
  const sdk = createContext({ services: { ragStrategy: createRetrievalContextStrategy({ provider, target: { name: "docs" } }) } });
  await assert.rejects(sdk.select({ ...input, strategy: { kind: "rag", corpus: { uri: "urn:other" } } }), /explicit.*mapper/);
  assert.equal(calls, 0);
  await assert.rejects(sdk.select(input, { signal: controller.signal }), /stop context retrieval/);
  assert.equal(calls, 1);
  const bad = createContext({ services: { ragStrategy: createRetrievalContextStrategy({ target: { name: "docs" }, provider: {
    async search(request) { return { target: request.target, candidates: [{ id: "bad", content: () => {} }] }; },
  } }) } });
  await assert.rejects(bad.select(input), /valid Context content/);
  const mapped = createContext({ services: { ragStrategy: createRetrievalContextStrategy({ target: { name: "docs" }, provider: {
    async search(request) { assert.equal(request.target.namespace, "tenant-a"); return { target: request.target, candidates: [{ id: "raw", content: 7 }] }; },
  }, mapInput: request => ({ target: { name: "docs", namespace: "tenant-a" }, query: { content: request.query } }),
  mapOutput: result => result.candidates.map(item => ({ id: item.id!, content: `value:${item.content}` })),
  }) } });
  assert.equal((await mapped.select(input)).context.items[0]?.content, "value:7");
});


test("Context retrieval skips zero-limit queries and validates cyclic candidate content before hashing", async () => {
  const strategy = createRetrievalContextStrategy({ target: { name: "docs" }, provider: {
    async search() { throw new Error("No I/O expected"); },
  } });
  assert.deepEqual(await strategy.select({ ...input, limit: 0 }), []);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => mapContextCandidates({ target: { name: "docs" }, candidates: [{ content: cyclic }] }), /valid Context content/);
});


test("Explicit retrieval Runtime is respected even when the calling Worker belongs to another Runtime", async () => {
  const { provider } = pipeline();
  const backend = createDitto({ workers: [createRetrievalWorker({ providers: new RetrievalTargetRegistry({ docs: {
    defaultStrategy: "vector", providers: { vector: provider },
  } }) })] });
  const caller = createDitto({ workers: [createContextWorker({ services: {
    ragStrategy: createRetrievalContextStrategy({ runtime: backend, target: { name: "docs" } }),
  } })] });
  try {
    assert.equal((await caller.invoke("CONTEXT.SELECT", input)).context.items.length, 2);
    const search = new RemoteRetrievalSearchProvider({ runtime: backend, target: { name: "docs" },
      mapOutput: output => output.candidates.map((candidate, index) => ({ memory: { id: String(index), content: candidate.content } })),
    });
    assert.equal((await search.search({ query: "question" }, { runtime: caller })).length, 3);
  } finally { await caller.close(); await backend.close(); }
});
