import assert from "node:assert/strict";
import test from "node:test";
import {
  createBraveWebSearchProvider, createContextWorker, createDitto, createInteractionWorker,
  createWebSearchTool, runToolCallFlow, type WebSearchProvider,
} from "../src/index.js";

const origin = "https://api.search.brave.com";

test("web_search validates input, bounds normalized results, and flows through Observation into Context", async () => {
  const calls: unknown[] = [];
  const provider: WebSearchProvider = {
    origin,
    async search(input) {
      calls.push(input);
      return [
        { title: "First", url: "https://example.com/one", snippet: "one" },
        { title: "Second", url: "https://example.com/two", snippet: "two" },
        { title: "Third", url: "https://example.com/three", snippet: "three" },
      ];
    },
  };
  const runtime = createDitto({
    sandbox: { tools: ["web_search"], network: [origin] },
    workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider })] }), createContextWorker()],
  });
  try {
    const flow = await runToolCallFlow(runtime, {
      context: { items: [] },
      call: { id: "search-1", name: "web_search", arguments: { query: "  Ditto Worker  ", limit: 2 } },
    });
    assert.deepEqual(calls, [{ query: "Ditto Worker", limit: 2 }]);
    assert.equal(flow.output.status, "success");
    assert.deepEqual(flow.output.structuredContent, {
      query: "Ditto Worker",
      results: [
        { title: "First", url: "https://example.com/one", snippet: "one" },
        { title: "Second", url: "https://example.com/two", snippet: "two" },
      ],
      truncated: true,
    });
    assert.deepEqual(flow.output.references, [
      { uri: "https://example.com/one" }, { uri: "https://example.com/two" },
    ]);
    assert.equal(flow.observation.source, "web_search");
    assert.equal(flow.context.items.length, 1);
    assert.equal(flow.context.items[0]?.metadata?.source, "web_search");
  } finally { await runtime.close(); }
});

test("web_search rejects invalid input plus tool and network deny paths before the provider", async () => {
  let searched = 0;
  const provider: WebSearchProvider = { origin, async search() { searched++; return []; } };
  const invalid = [
    { query: "" },
    { query: "x".repeat(601) },
    { query: new Array(76).fill("word").join(" ") },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 21 },
    { query: "valid", limit: 1, endpoint: "https://evil.example" },
  ];
  const validRuntime = createDitto({
    sandbox: { tools: ["web_search"], network: [origin] },
    workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider })] })],
  });
  try {
    for (const [index, arguments_] of invalid.entries()) {
      await assert.rejects(validRuntime.invoke("INTERACTION.ACT.TOOL", {
        call: { id: `invalid-${index}`, name: "web_search", arguments: arguments_ },
      }));
    }
  } finally { await validRuntime.close(); }

  for (const [index, sandbox] of [
    { network: [origin] },
    { tools: ["web_search"] },
  ].entries()) {
    const runtime = createDitto({ sandbox,
      workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider })] })] });
    try {
      await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: {
        id: `denied-${index}`, name: "web_search", arguments: { query: "Ditto" },
      } }));
    } finally { await runtime.close(); }
  }
  assert.equal(searched, 0);
  assert.throws(() => createWebSearchTool({ provider: { ...provider, origin: `${origin}/path` } }), /origin/);
});

test("web_search bounds result text without splitting Unicode", async () => {
  const provider: WebSearchProvider = { origin, async search() { return [{
    title: "😀".repeat(300), url: "https://example.com/long", snippet: "界".repeat(3_000),
  }]; } };
  const runtime = createDitto({
    sandbox: { tools: ["web_search"], network: [origin] },
    workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider })] })],
  });
  try {
    const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call: {
      id: "bounded", name: "web_search", arguments: { query: "Ditto", limit: 1 },
    } });
    const structured = result.structuredContent as { results: { title: string; snippet: string }[]; truncated: boolean };
    assert.equal([...structured.results[0]!.title].length, 256);
    assert.equal([...structured.results[0]!.snippet].length, 2_048);
    assert.doesNotMatch(structured.results[0]!.title, /�/);
    assert.equal(structured.truncated, true);
  } finally { await runtime.close(); }
});

test("web_search sanitizes provider failures and malformed results without retry", async () => {
  const providers: WebSearchProvider[] = [
    { origin, async search() { throw new Error("Bearer secret-token at C:\\private\\stack.ts:12"); } },
    { origin, async search() { return [{ title: "Bad", url: "file:///etc/passwd", snippet: "x" }]; } },
    { origin, async search() { return [{ title: "Bad", url: "https://user:pass@example.com", snippet: "x" }]; } },
  ];
  for (const [index, provider] of providers.entries()) {
    let calls = 0;
    const counted: WebSearchProvider = { origin, async search(input) { calls++; return provider.search(input); } };
    const runtime = createDitto({
      sandbox: { tools: ["web_search"], network: [origin] },
      workers: [createInteractionWorker({ tools: [createWebSearchTool({ provider: counted })] })],
    });
    try {
      const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call: {
        id: `failed-${index}`, name: "web_search", arguments: { query: "Ditto" },
      } });
      assert.equal(result.status, "failed");
      assert.deepEqual(result.error, { code: "WEB_SEARCH_FAILED", message: "Web search provider failed", retryable: false });
      assert.equal(result.content, undefined);
      assert.equal(result.structuredContent, undefined);
      assert.equal(calls, 1);
    } finally { await runtime.close(); }
  }
});

test("Brave adapter maps the official REST request and response with native fetch semantics", async () => {
  const requests: { input: string; init?: RequestInit }[] = [];
  const provider = createBraveWebSearchProvider({
    apiKey: "test-key",
    fetch: async (input, init) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ web: { results: [
        { title: "Official", url: "https://example.com/official", description: "Result description" },
      ] } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const results = await provider.search({ query: "Ditto Worker", limit: 3 });
  assert.equal(provider.origin, origin);
  assert.deepEqual(results, [{ title: "Official", url: "https://example.com/official", snippet: "Result description" }]);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0]!.input);
  assert.equal(url.href, "https://api.search.brave.com/res/v1/web/search?q=Ditto+Worker&count=3");
  assert.equal(requests[0]!.init?.method, "GET");
  assert.equal(new Headers(requests[0]!.init?.headers).get("X-Subscription-Token"), "test-key");
  assert.equal(requests[0]!.init?.redirect, "error");
});

test("Brave adapter validates configuration and returns fixed errors for HTTP or JSON failures", async () => {
  assert.throws(() => createBraveWebSearchProvider({ apiKey: "" }), /configuration/);
  assert.throws(() => createBraveWebSearchProvider({ apiKey: "x", timeoutMs: 0 }), /configuration/);
  const cases = [
    async () => new Response("private upstream details", { status: 429 }),
    async () => new Response("not-json", { status: 200 }),
    async () => new Response(JSON.stringify({ web: { results: "bad" } }), { status: 200 }),
  ];
  for (const fetch of cases) {
    const provider = createBraveWebSearchProvider({ apiKey: "test-key", fetch });
    await assert.rejects(provider.search({ query: "Ditto", limit: 2 }), error => {
      assert.doesNotMatch(String(error), /private upstream details|test-key|not-json/);
      return true;
    });
  }
});
