import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, defineWorker, runReactFlow, ProviderRegistry, loadRuntimeConfig, observeExternalResult, createInteractionNodes, McpRegistry } from "../src/index.js";
import { createInfer, createInferWorker, type SampleInput, type SampleOutput } from "../src/worker/infer/index.js";
const input = { model: { model: "fixture" }, messages: [{ role: "user" as const, content: "lookup" }], actions: [{ name: "lookup", inputSchema: {} }] };
const action = (id = "call"): SampleOutput => ({ message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id, name: "lookup", arguments: { term: "q" } }], usage: { totalTokens: 3 } });
const answer: SampleOutput = { message: { role: "assistant", content: "answer" }, finishReason: "stop", usage: { totalTokens: 4 } };
function fixture(outputs: SampleOutput[], fail = false) {
  const requests: SampleInput[] = []; const scopes: string[] = [];
  const providers = new ProviderRegistry({ test: { async invoke(value) { requests.push(structuredClone(value)); const output = outputs.shift(); assert.ok(output); return output; } } });
  const runtime = createDitto({ providers, workers: [createInferWorker({ concurrency: 1 }), defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": async ({ call }, ctx) => { scopes.push(ctx.execution!.graphId); assert.equal(call.name, "lookup"); if (fail) throw new Error("tool failed"); return { callId: call.id, source: "lookup", status: "success", content: "found" }; },
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
  } })] });
  return { runtime, requests, scopes };
}
test("Runtime ReAct routes declared actions through Graph and feeds observations to SAMPLE", async () => {
  const f = fixture([action(), answer]);
  try {
    const result = await runReactFlow(f.runtime, input, { graphId: "lookup-flow" });
    assert.equal(result.status, "completed"); assert.equal(result.result.content, "answer"); assert.deepEqual(result.actionRequests, []);
    assert.deepEqual(f.scopes, ["lookup-flow"]); assert.equal(result.usage.totalTokens, 7);
    assert.equal(f.requests[1]?.messages.at(-1)?.role, "tool"); assert.match(String(f.requests[1]?.messages.at(-1)?.content), /found/);
    assert.equal(f.requests[1]?.messages.at(-1)?.metadata?.actionRequestId, "call");
    assert.ok(f.requests[1]?.messages.at(-2)?.metadata?.actionRequests);
  } finally { await f.runtime.close(); }
});

test("ReAct uses caller-owned MCP binding and ignores model-supplied routing fields", async () => {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const mcp = new McpRegistry();
  mcp.register("approved", { listTools: async () => ({ tools: [] }), async callTool(params) { calls.push(params); return { content: "MCP answer" }; } });
  const providers = new ProviderRegistry({ fixture: { async invoke(request) {
    return request.messages.length === 1
      ? { ...action(), actionRequests: [{ id: "mcp", name: "lookup", arguments: { term: "q", server: "untrusted" }, targetNode: "UNTRUSTED.TARGET" }] } as unknown as SampleOutput
      : answer;
  } } });
  const runtime = createDitto({ providers, sandbox: { mcp: ["approved"] }, workers: [createInferWorker(), defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ mcp }) })] });
  try {
    const result = await runReactFlow(runtime, { ...input, actions: [{ name: "lookup", inputSchema: {}, target: { kind: "mcp", server: "approved", toolName: "remote_search" } }] });
    assert.equal(result.status, "completed"); assert.equal(result.observations[0]?.callId, "mcp");
    assert.equal(calls[0]?.name, "remote_search"); assert.equal(calls[0]?.arguments.server, "untrusted");
  } finally { await runtime.close(); }
});

test("ReAct returns business failures to SAMPLE but stops on unknown external outcomes", async () => {
  for (const status of ["failed", "cancelled", "timeout", "unknown"] as const) {
    let samples = 0;
    const runtime = createDitto({ providers: new ProviderRegistry({ fixture: { async invoke() { samples++; return samples === 1 ? action() : answer; } } }), workers: [createInferWorker(), defineWorker({ type: "INTERACTION", nodes: {
      "INTERACTION.ACT.TOOL": async ({ call }) => ({ callId: call.id, source: call.name, status, error: { code: "REMOTE_ERROR", message: "Remote failed" } }),
      "INTERACTION.OBSERVE": async value => observeExternalResult(value),
    } })] });
    try {
      const result = await runReactFlow(runtime, input);
      assert.equal(result.observations[0]?.status, status);
      assert.equal(samples, status === "failed" ? 2 : 1);
      assert.equal(result.status, status === "failed" ? "completed" : "partial");
      if (status !== "failed") assert.equal(result.stopReason, "dependency_failed");
    } finally { await runtime.close(); }
  }
});
test("ReAct continues after business failure and preserves actions not yet executed", async () => {
  const actions = [
    { id: "first", name: "lookup", arguments: { order: 1 } },
    { id: "second", name: "lookup", arguments: { order: 2 } },
  ];
  const multi: SampleOutput = { ...action(), actionRequests: actions };
  let samples = 0; const calls: string[] = [];
  const continuing = createDitto({ providers: new ProviderRegistry({ fixture: { async invoke() { samples++; return samples === 1 ? multi : answer; } } }), workers: [createInferWorker(), defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": async ({ call }) => { calls.push(call.id); return call.id === "first"
      ? { callId: call.id, source: call.name, status: "failed", error: { code: "REJECTED", message: "Request rejected" } }
      : { callId: call.id, source: call.name, status: "success", content: "done" }; },
    "INTERACTION.OBSERVE": async value => observeExternalResult(value),
  } })] });
  try {
    const result = await runReactFlow(continuing, input);
    assert.equal(result.status, "completed"); assert.deepEqual(calls, ["first", "second"]);
    assert.deepEqual(result.observations.map(item => item.status), ["failed", "success"]);
  } finally { await continuing.close(); }

  const interrupted = createDitto({ providers: new ProviderRegistry({ fixture: { invoke: async () => multi } }), workers: [createInferWorker(), defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": async () => { throw new Error("transport failed"); },
    "INTERACTION.OBSERVE": async value => observeExternalResult(value),
  } })] });
  try {
    const result = await runReactFlow(interrupted, input);
    assert.equal(result.stopReason, "dependency_failed");
    assert.deepEqual(result.actionRequests.map(item => item.id), ["second"]);
  } finally { await interrupted.close(); }
});
test("ReAct budgets preserve pending actions and do not perform unobservable external work", async () => {
  for (const [constraints, reason] of [[{ maxSteps: 1 }, "max_steps"], [{ maxActionCalls: 0 }, "max_action_calls"], [{ maxTotalTokens: 3 }, "max_tokens"]] as const) {
    const f = fixture([action()]);
    try { const result = await runReactFlow(f.runtime, { ...input, constraints });
      assert.equal(result.stopReason, reason); assert.equal(result.actionRequests.length, 1); assert.equal(result.status, "partial"); assert.equal(f.scopes.length, 0);
    } finally { await f.runtime.close(); }
  }
  const duplicate = fixture([{ ...action(), actionRequests: [{ id: "same", name: "lookup", arguments: {} }, { id: "same", name: "lookup", arguments: {} }] }]);
  try {
    const result = await runReactFlow(duplicate.runtime, input);
    assert.equal(result.error?.code, "INVALID_MODEL_OUTPUT"); assert.equal(duplicate.scopes.length, 0);
  } finally { await duplicate.runtime.close(); }
  const f = fixture([{ ...answer, usage: undefined } as unknown as SampleOutput]);
  try { assert.equal((await runReactFlow(f.runtime, { ...input, constraints: { maxTotalTokens: 10 } })).error?.code, "USAGE_UNAVAILABLE"); }
  finally { await f.runtime.close(); }
});
test("ReAct reports dependency failure and routes custom action targets using caller descriptors", async () => {
  const f = fixture([action()], true);
  try { const result = await runReactFlow(f.runtime, input); assert.equal(result.stopReason, "dependency_failed"); assert.equal(result.observations.length, 0); assert.equal(result.error?.message, "tool failed"); }
  finally { await f.runtime.close(); }
  const custom = fixture([{ ...action(), actionRequests: [{ id: "c", name: "lookup", arguments: { context: { items: [] }, query: { role: "user", content: "query" } } }] }, answer]);
  custom.runtime.register(defineWorker({ type: "CONTEXT", nodes: { "CONTEXT.SELECT": async ({ context }, ctx) => { assert.equal(ctx.execution?.graphId, "react"); return context; } } }));
  try { assert.equal((await runReactFlow(custom.runtime, { ...input, actions: [{ ...input.actions[0]!, target: { kind: "node", node: "CONTEXT.SELECT" } }] })).status, "completed"); assert.equal(custom.scopes.length, 0); }
  finally { await custom.runtime.close(); }
});
test("ReAct deadline and cancellation stop scheduling without claiming to cancel remote work", async () => {
  let resolve!: (output: SampleOutput) => void;
  const runtime = createDitto({ providers: new ProviderRegistry({ slow: { invoke: () => new Promise(r => { resolve = r; }) } }), workers: [createInferWorker()] });
  try {
    const result = await runReactFlow(runtime, input, { timeoutMs: 15 }); assert.equal(result.stopReason, "timeout");
    resolve(answer);
    const controller = new AbortController(); controller.abort("cancelled");
    assert.equal((await runReactFlow(runtime, input, { signal: controller.signal })).stopReason, "cancelled");
  } finally { await runtime.close(); }
});
test("SDK and Worker share Runtime provider selection and support multiple vendors", async () => {
  const config = loadRuntimeConfig({ DITTO_SHARED_PROVIDERS: "one,two,three", DITTO_SHARED_PROVIDER_TWO_KIND: "anthropic", DITTO_SHARED_PROVIDER_THREE_KIND: "gemini", DITTO_WORKER_INFER_MODEL_PROVIDER: "two", DITTO_WORKER_INFER_MODEL: "fixture" });
  assert.equal(config.providers.three?.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  const providers = new ProviderRegistry(Object.fromEntries(["one", "two", "three"].map(name => [name, { invoke: async () => ({ ...answer, message: { role: "assistant" as const, content: name } }) }])));
  const runtime = createDitto({ config, providers, workers: [createInferWorker()] });
  try {
    assert.equal((await runtime.invoke("INFER.REASONING.SAMPLE", input)).output?.message.content, "two");
    assert.equal((await createInfer({ runtime }).reasoning.sample(input)).output?.message.content, "two");
    assert.equal((await runtime.invoke("INFER.REASONING.SAMPLE", { ...input, model: { model: "fixture", provider: "three" } })).output?.message.content, "three");
    assert.equal((await createInfer({ providers }).reasoning.sample(input)).error?.code, "PROVIDER_NOT_FOUND");
  } finally { await runtime.close(); }
});

test("concurrent ReAct flows retain their own Graph scope and message history", async () => {
  const runtime = createDitto({ providers: new ProviderRegistry({ fixture: { invoke: async request => request.messages.length === 1 ? action() : { ...answer, message: { role: "assistant", content: String(request.messages.at(-1)!.content) } } } }), workers: [createInferWorker(), defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": async ({ call }, ctx) => ({ callId: call.id, source: "scope", status: "success", content: ctx.execution!.graphId }),
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
  } })] });
  try {
    const results = await Promise.all(["first", "second"].map(graphId => runReactFlow(runtime, input, { graphId })));
    assert.match(String(results[0]?.result.content), /first/); assert.match(String(results[1]?.result.content), /second/);
    assert.ok(results.every(result => result.status === "completed"));
  } finally { await runtime.close(); }
});

test("Worker and local SDK honor the shared Runtime timeout without per-worker duplication", async () => {
  const runtime = createDitto({ config: loadRuntimeConfig({}, { runtime: { timeoutMs: 10 } }), providers: new ProviderRegistry({ slow: { invoke: () => new Promise(() => {}) } }), workers: [createInferWorker()] });
  try {
    assert.equal((await runtime.invoke("INFER.REASONING.SAMPLE", input)).status, "timeout");
    assert.equal((await createInfer({ runtime }).reasoning.sample(input)).status, "timeout");
  } finally { await runtime.close(); }
});
