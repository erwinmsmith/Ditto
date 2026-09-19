import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, defineWorker, runReactFlow, ProviderRegistry, loadRuntimeConfig } from "../src/index.js";
import { createInfer, createInferWorker, type SampleInput, type SampleOutput } from "../src/worker/infer/index.js";
const input = { model: { model: "fixture" }, messages: [{ role: "user" as const, content: "lookup" }], actions: [{ name: "lookup", inputSchema: {} }] };
const action = (id = "call"): SampleOutput => ({ message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id, name: "lookup", arguments: { term: "q" }, targetNode: "UNTRUSTED.TARGET" }], usage: { totalTokens: 3 } });
const answer: SampleOutput = { message: { role: "assistant", content: "answer" }, finishReason: "stop", usage: { totalTokens: 4 } };
function fixture(outputs: SampleOutput[], fail = false) {
  const requests: SampleInput[] = []; const scopes: string[] = [];
  const providers = new ProviderRegistry({ test: { async invoke(value) { requests.push(structuredClone(value)); const output = outputs.shift(); assert.ok(output); return output; } } });
  const runtime = createDitto({ providers, workers: [createInferWorker({ concurrency: 1 }), defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": async ({ call }, ctx) => { scopes.push(ctx.execution!.graphId); assert.equal(call.name, "lookup"); if (fail) throw new Error("tool failed"); return { source: "lookup", content: "found" }; },
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
test("ReAct budgets preserve pending actions and do not perform unobservable external work", async () => {
  for (const [constraints, reason] of [[{ maxSteps: 1 }, "max_steps"], [{ maxActionCalls: 0 }, "max_action_calls"], [{ maxTotalTokens: 3 }, "max_tokens"]] as const) {
    const f = fixture([action()]);
    try { const result = await runReactFlow(f.runtime, { ...input, constraints });
      assert.equal(result.stopReason, reason); assert.equal(result.actionRequests.length, 1); assert.equal(result.status, "partial"); assert.equal(f.scopes.length, 0);
    } finally { await f.runtime.close(); }
  }
  const f = fixture([{ ...answer, usage: undefined } as unknown as SampleOutput]);
  try { assert.equal((await runReactFlow(f.runtime, { ...input, constraints: { maxTotalTokens: 10 } })).error?.code, "USAGE_UNAVAILABLE"); }
  finally { await f.runtime.close(); }
});
test("ReAct reports dependency failure and routes custom action targets using caller descriptors", async () => {
  const f = fixture([action()], true);
  try { const result = await runReactFlow(f.runtime, input); assert.equal(result.stopReason, "dependency_failed"); assert.equal(result.observations[0]?.status, "failed"); assert.equal(result.error?.message, "tool failed"); }
  finally { await f.runtime.close(); }
  const custom = fixture([{ ...action(), actionRequests: [{ id: "c", name: "lookup", arguments: { context: { items: [] }, query: { role: "user", content: "query" } } }] }, answer]);
  custom.runtime.register(defineWorker({ type: "CONTEXT", nodes: { "CONTEXT.SELECT": async ({ context }, ctx) => { assert.equal(ctx.execution?.graphId, "react"); return context; } } }));
  try { assert.equal((await runReactFlow(custom.runtime, { ...input, actions: [{ ...input.actions[0]!, targetNode: "CONTEXT.SELECT" }] })).status, "completed"); assert.equal(custom.scopes.length, 0); }
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
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "one,two,three", DITTO_PROVIDER_TWO_KIND: "anthropic", DITTO_PROVIDER_THREE_KIND: "gemini", DITTO_MODEL_PROVIDER: "two", DITTO_MODEL: "fixture" });
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
    "INTERACTION.ACT.TOOL": async (_input, ctx) => ({ source: "scope", content: ctx.execution!.graphId }),
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
