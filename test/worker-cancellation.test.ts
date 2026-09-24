import assert from "node:assert/strict";
import test from "node:test";
import {
  createDitto, createInferWorker, createMemory, createMemoryWorker, createInteractionWorker,
  createBraveWebSearchProvider, createWebSearchTool, type MemoryCallOptions, type MemoryStore,
} from "../src/index.js";
import { createRetrievalWorker, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";

const emptyStore: MemoryStore = {
  get: async () => [], query: async () => ({ items: [] }), write: async () => [], update: async () => [], delete: async () => ({ deleted: [] }),
};

test("Runtime cancellation reaches the actual INFER model provider", async () => {
  const controller = new AbortController(); let forwarded = false;
  const runtime = createDitto({ workers: [createInferWorker({ providers: { test: { async invoke(_input, { signal }) {
    controller.abort(new Error("stop model")); forwarded = signal.aborted; signal.throwIfAborted();
    throw new Error("Model cancellation was not forwarded");
  } } } })] });
  try {
    await assert.rejects(runtime.invoke("INFER.REASONING.SAMPLE", { model: { provider: "test", model: "test" },
      messages: [{ role: "user", content: "task" }] }, { signal: controller.signal }), /stop model/);
    assert.equal(forwarded, true);
  } finally { await runtime.close(); }
});

test("MEMORY direct calls forward cancellation to all storage operations and return cancelled", async () => {
  for (const operation of ["get", "query", "write", "update", "delete", "search"] as const) {
    const controller = new AbortController(); let calls = 0;
    const stop = async (_input: unknown, options?: MemoryCallOptions): Promise<never> => {
      assert.equal(options?.signal, controller.signal); calls++;
      controller.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable");
    };
    const sdk = createMemory({ store: { get: stop, query: stop, write: stop, update: stop, delete: stop, search: stop } });
    const options = { signal: controller.signal };
    const callsByName = {
      get: () => sdk.get({ ids: ["a"] }, options), query: () => sdk.query({}, options),
      write: () => sdk.write({ memories: [{ content: "value" }] }, options),
      update: () => sdk.update({ memories: [{ id: "a", content: "value" }] }, options),
      delete: () => sdk.delete({ ids: ["a"] }, options), search: () => sdk.search({ query: "value" }, options),
    };
    assert.equal((await callsByName[operation]()).status, "cancelled"); assert.equal(calls, 1);
    assert.equal((await callsByName[operation]()).status, "cancelled"); assert.equal(calls, 1);
  }
});

test("MEMORY -> RETRIEVAL preserves the caller signal through both Worker boundaries", async () => {
  const controller = new AbortController(); let forwarded = false;
  const runtime = createDitto();
  runtime.register(createRetrievalWorker({ providers: new RetrievalTargetRegistry({ docs: {
    defaultStrategy: "text", providers: { text: { async search(_input, context) {
      assert.ok(context?.signal); controller.abort(new Error("stop retrieval"));
      assert.equal(context.signal.aborted, true);
      forwarded = context!.signal!.aborted; context!.signal!.throwIfAborted(); throw new Error("unreachable");
    } } },
  } }) }));
  runtime.register(createMemoryWorker({ store: emptyStore, search: new RemoteRetrievalSearchProvider({ runtime, target: { name: "docs" } }) }));
  try {
    await assert.rejects(runtime.invoke("MEMORY.SEARCH", { query: "text" }, { signal: controller.signal }), /stop retrieval/);
    assert.equal(forwarded, true);
  } finally { await runtime.close(); }
});

test("MCP cancellation reaches invocation and stops discovery before another page", async () => {
  for (const operation of ["invoke", "discover"] as const) {
    const controller = new AbortController(); let calls = 0;
    const runtime = createDitto({ sandbox: { mcp: ["docs"] }, workers: [createInteractionWorker({ mcp: { docs: {
      async callTool(_input, options) { assert.equal(options?.signal, controller.signal); calls++; controller.abort(new Error("stop mcp")); return { content: "ignored" }; },
      async listTools(_input, options) { assert.equal(options?.signal, controller.signal); calls++; controller.abort(new Error("stop mcp")); return { tools: [], nextCursor: "more" }; },
    } } })] });
    try {
      await assert.rejects(runtime.invoke("INTERACTION.ACT.MCP", operation === "discover"
        ? { operation, server: "docs" } : { operation, server: "docs", call: { id: "call", name: "read", arguments: {} } },
      { signal: controller.signal }), /stop mcp/);
      assert.equal(calls, 1);
    } finally { await runtime.close(); }
  }
});

test("web search abort reaches HTTP fetch and oversized responses cancel their stream", async () => {
  const controller = new AbortController(); let forwarded = false;
  const provider = createBraveWebSearchProvider({ apiKey: "test", fetch: async (_input, init) => {
    controller.abort(new Error("stop web")); forwarded = init!.signal!.aborted; init!.signal!.throwIfAborted(); throw new Error("unreachable");
  } });
  const runtime = createDitto({ sandbox: { tools: ["web_search"], network: [provider.origin] },
    workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider })] })] });
  try {
    await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "web", name: "web_search", arguments: { query: "query" } } },
      { signal: controller.signal }), /stop web/);
    assert.equal(forwarded, true);
  } finally { await runtime.close(); }
  let cancelled = false;
  const bounded = createBraveWebSearchProvider({ apiKey: "test", maxResponseBytes: 8, fetch: async () => new Response(new ReadableStream({
    start(control) { control.enqueue(new TextEncoder().encode("oversized response")); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(bounded.search({ query: "query", limit: 1 }), /response is too large/);
  assert.equal(cancelled, true);
});
