import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextError, createContext, createContextWorker, createDitto, createRagStrategy,
  type ContextItem,
} from "../src/index.js";

test("LOAD normalizes sources into immutable stable snapshots and applies duplicate policy", async () => {
  const context = createContext();
  const message = { role: "user" as const, content: { query: "hello" } };
  const first = await context.load({ sources: [
    message,
    { uri: "urn:document", mediaType: "text/plain" },
    { id: "fixed", content: "old" },
    { id: "fixed", content: "new" },
  ] });
  const second = await context.load({ sources: [message] });
  assert.equal(first.items[0]?.id, second.items[0]?.id);
  assert.equal(first.items[0]?.metadata?.role, "user");
  assert.equal(first.items[1]?.source?.uri, "urn:document");
  assert.equal(first.items[2]?.content, "new");
  (message.content as { query: string }).query = "mutated";
  assert.deepEqual(first.items[0]?.content, { query: "hello" });
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.items)); assert.ok(Object.isFrozen(first.items[0]));

  assert.equal((await createContext({ policy: { duplicate: "keep-first" } }).load({ sources: [
    { id: "same", content: "first" }, { id: "same", content: "second" },
  ] })).items[0]?.content, "first");
  await assert.rejects(createContext({ policy: { duplicate: "reject" } }).load({ sources: [
    { id: "same", content: "first" }, { id: "same", content: "second" },
  ] }), (error: unknown) => error instanceof ContextError && error.code === "DUPLICATE_ITEM");
});

test("UPDATE is ordered, idempotent and keeps cross-Worker ingress explicit", async () => {
  const context = createContext();
  const input = {
    context: { items: [{ id: "a", content: "remove" }, { id: "b", content: "old" }] },
    removeIds: ["a"],
    add: [{ id: "a", content: "added" }],
    ingress: [{ id: "b", sourceNode: "MEMORY.SEARCH" as const, content: "restored", metadata: { score: 0.9 } }],
  };
  const updated = await context.update(input);
  assert.deepEqual(updated.items.map(item => [item.id, item.content]), [["b", "restored"], ["a", "added"]]);
  assert.deepEqual(updated.items[0]?.metadata, { score: 0.9, sourceNode: "MEMORY.SEARCH" });
  assert.deepEqual(await context.update({ ...input, context: updated, removeIds: [] }), updated);
  await assert.rejects(createContext({ policy: { missingRemoval: "reject" } }).update({
    context: { items: [] }, removeIds: ["missing"],
  }), (error: unknown) => error instanceof ContextError && error.code === "MISSING_ITEM");
});

test("SELECT separates infer and memory purposes and keeps RAG inside the strategy boundary", async () => {
  const source = { items: [
    { id: "system", content: "security policy", metadata: { role: "system", protected: true } },
    { id: "match", content: "typescript context worker" },
    { id: "private", content: "typescript secret", metadata: { private: true, memoryCandidate: true } },
    { id: "memory", content: "reusable implementation fact", metadata: { memoryCandidate: true, reusable: true } },
  ] };
  const context = createContext({ services: { tokenEstimator: { estimate: content => String(content).length } } });
  const infer = await context.select({ context: source, purpose: "infer", query: "typescript", limit: 2 });
  assert.deepEqual(infer.selectedItemIds, ["system", "private"]);
  assert.equal(infer.context.items.length, 2);
  const memory = await context.select({ context: source, purpose: "memory", limit: 4 });
  assert.equal(memory.selectedItemIds.includes("private"), false);
  assert.equal(memory.selectedItemIds[0], "memory");
  assert.deepEqual((await context.select({ context: source, purpose: "infer", limit: 0 })).selectedItemIds, []);
  assert.deepEqual((await context.select({ context: source, purpose: "infer", maxTokens: 1 })).selectedItemIds, []);

  const calls: string[] = [];
  const ragStrategy = createRagStrategy({
    embed: { async embed() { calls.push("embed"); return [1, 0]; } },
    retrieve: { async retrieve(input) { calls.push("retrieve"); assert.deepEqual(input.embedding, [1, 0]); return [
      { item: { id: "rag-low", content: "low" }, score: 0.1 },
      { item: { id: "rag-high", content: "high" }, score: 0.9 },
    ]; } },
    rank: { async rank(input) { calls.push("rank"); return [...input.candidates].sort((a, b) => b.score! - a.score!); } },
  });
  const rag = await createContext({ services: { ragStrategy } }).select({
    context: source, purpose: "infer", query: "worker", limit: 1,
    strategy: { kind: "rag", corpus: { uri: "urn:corpus" } },
  });
  assert.deepEqual(calls, ["embed", "retrieve", "rank"]);
  assert.deepEqual(rag.selectedItemIds, ["rag-high"]);
  await assert.rejects(createContext().select({ context: source, purpose: "infer", strategy: { kind: "rag" } }),
    (error: unknown) => error instanceof ContextError && error.code === "STRATEGY_UNAVAILABLE");
});

test("COMPRESS enforces budgets without splitting tool correlations or dropping protected items", async () => {
  const items: ContextItem[] = [
    { id: "system", content: "policy", metadata: { role: "system" } },
    { id: "tool-call", content: "call", metadata: { callId: "call-1" } },
    { id: "tool-result", content: "result", metadata: { callId: "call-1" } },
    { id: "recent", content: "recent", metadata: { priority: 1 } },
  ];
  const context = createContext({ services: { tokenEstimator: { estimate: () => 1 } } });
  const compressed = await context.compress({ context: { items }, maxItems: 2 });
  assert.deepEqual(compressed.items.map(item => item.id), ["system", "recent"]);
  await assert.rejects(context.compress({ context: { items }, maxItems: 0 }),
    (error: unknown) => error instanceof ContextError && error.code === "BUDGET_UNSATISFIABLE");
  await assert.rejects(createContext({ services: { compressor: { compress: async () => ({ items: [] }) } } }).compress({
    context: { items }, maxItems: 4,
  }), (error: unknown) => error instanceof ContextError && error.code === "INVALID_PROVIDER_OUTPUT");
});

test("Context Worker exposes exactly four leaf capabilities and shares the direct implementation", async () => {
  const worker = createContextWorker({ concurrency: 2 });
  assert.deepEqual(worker.capabilities, ["CONTEXT.LOAD", "CONTEXT.SELECT", "CONTEXT.UPDATE", "CONTEXT.COMPRESS"]);
  assert.equal(worker.concurrency, 2);
  const runtime = createDitto({ workers: [worker] });
  try {
    const loaded = await runtime.invoke("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] });
    const selected = await runtime.invoke("CONTEXT.SELECT", { context: loaded, purpose: "infer" });
    assert.deepEqual(selected.selectedItemIds, [loaded.items[0]?.id]);
  } finally { await runtime.close(); }
});

test("malformed Context inputs fail before strategies or compressors run", async () => {
  let calls = 0;
  const context = createContext({ services: {
    selector: { async select() { calls++; return []; } },
    compressor: { async compress() { calls++; return { items: [] }; } },
  } });
  await assert.rejects(context.execute("CONTEXT.LOAD", { sources: [null] } as never), /sources\[0\] must be an object/);
  await assert.rejects(context.execute("CONTEXT.SELECT", { context: { items: [] }, purpose: "other", strategy: { kind: "provider", name: "x" } } as never), /purpose/);
  await assert.rejects(context.execute("CONTEXT.UPDATE", { context: { items: [] }, ingress: [{ id: "x", sourceNode: "invalid", content: "x" }] } as never), /qualified Node ID/);
  await assert.rejects(context.execute("CONTEXT.COMPRESS", { context: { items: [] }, maxItems: -1 } as never), /maxItems/);
  assert.equal(calls, 0);
});

test("scoped Context state is explicit, isolated, read-only on SELECT, and rejects concurrent overwrites", async () => {
  const states = new Map<string, import("../src/index.js").StoredContext>();
  let version = 0;
  const store: import("../src/index.js").ContextStateStore = {
    async get(scope) { return states.get(JSON.stringify(scope)); },
    async compareAndSet(scope, expected, next) {
      const key = JSON.stringify(scope);
      if (states.get(key)?.version !== expected) throw new ContextError("STATE_CONFLICT", "conflict");
      const value = { version: String(++version), context: next };
      states.set(key, value); return value;
    },
  };
  const client = createContext({ services: { stateStore: store } });
  const scope = { sessionId: "one" };
  const conflict = (e: unknown) => e instanceof ContextError && e.code === "STATE_CONFLICT";
  await client.load({ scope, sources: [{ id: "first", content: "hello" }] });
  assert.deepEqual(await client.load({ scope }), { items: [{ id: "first", content: "hello" }] });
  await client.select({ scope, purpose: "infer", limit: 0 });
  assert.equal((await client.load({ scope })).items.length, 1);
  await assert.rejects(client.load({ scope: { sessionId: "two" } }), /absent or expired/);
  const old = (await store.get(scope))!.version;
  const writes = await Promise.allSettled([
    client.update({ scope, add: [{ id: "a", content: "a" }] }),
    client.update({ scope, add: [{ id: "b", content: "b" }] }),
  ]);
  assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(writes.some(result => result.status === "rejected" && conflict(result.reason)));
  assert.equal((await client.load({ scope })).items.length, 2);
  await assert.rejects(client.compress({ scope, expectedVersion: old, maxItems: 1 }), conflict);
  await client.compress({ scope, maxItems: 1 });
  assert.equal((await client.load({ scope })).items.length, 1);
  states.clear();
  await assert.rejects(client.update({ scope, add: [] }), /absent or expired/);
  await assert.rejects(client.load({ scope: {}, sources: [] }), /identifier/);
  await assert.rejects(client.select({ scope, context: { items: [] }, purpose: "infer" } as never), /either context or scope/);
  await assert.rejects(createContext().load({ scope }), /Configure a Context state store/);
  await assert.rejects(client.execute("UNKNOWN" as never, {} as never), /Unknown Context node/);
  // Explicit payload computation never calls the configured store.
  assert.deepEqual(await client.load({ sources: [] }), { items: [] });
  const runtime = createDitto({ workers: [createContextWorker({ services: { stateStore: store } })] });
  try {
    await runtime.invoke("CONTEXT.LOAD", { scope, sources: [{ id: "runtime", content: "ok" }] });
    assert.equal((await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer" })).selectedItemIds[0], "runtime");
  } finally { await runtime.close(); }
});

test("Context skips token estimation without a token budget and enforces compressor inline limits", async () => {
  let estimates = 0;
  const client = createContext({ services: { tokenEstimator: { estimate() { estimates++; return 1; } } } });
  await client.compress({ context: { items: [{ id: "one", content: "one" }] }, maxItems: 1 });
  assert.equal(estimates, 0);
  await assert.rejects(createContext({ policy: { maxInlineBytes: 8 }, services: {
    compressor: { async compress() { return { items: [{ id: "one", content: "too much inline content" }] }; } },
  } }).compress({ context: { items: [{ id: "one", content: "one" }] } }),
  (e: unknown) => e instanceof ContextError && e.code === "INLINE_LIMIT_EXCEEDED");
});
