import assert from "node:assert/strict";
import test from "node:test";
import {
  createDitto, createContextWorker, graph, checkpointState, restoreState, BranchStore,
  TokenBudget, budgetedProvider, BudgetExceededError,
  type GraphCheckpoint, type StateCheckpoint, type LoopCheckpointState,
} from "../src/index.js";
import { runGraph } from "../src/runtime/graph.js";
import type { ModelProvider } from "../src/worker/infer/providers/types.js";

test("JSON checkpoints roundtrip and reject incompatible/corrupted/live state", () => {
  const cp = checkpointState("episode", "v1", { nested: [1, "hello"] });
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(cp)), "episode", "v1"), cp.state);
  assert.throws(() => restoreState(cp, "other", "v1"));
  assert.throws(() => restoreState(cp, "episode", "v2"));
  assert.throws(() => restoreState({ ...cp, state: { nested: [] } }, "episode", "v1"));
  assert.throws(() => checkpointState("s", "1", { resource: new Map() }));
  assert.throws(() => checkpointState("s", "1", { run: () => 1 }));
  assert.throws(() => checkpointState("s", "1", new Array(2)));
  const cycle: Record<string, unknown> = {}; cycle["self"] = cycle;
  assert.throws(() => checkpointState("s", "1", cycle));
});

test("graph resumes in another runtime without repeating completed nodes", async () => {
  const plan = graph<string>("three")
    .node("a", "CONTEXT.LOAD", [], input => ({ sources: [{ role: "user", content: input }] }))
    .node("b", "CONTEXT.LOAD", ["a"], (_i, { a }) => ({ sources: a.items }))
    .node("c", "CONTEXT.LOAD", ["b"], (_i, { b }) => ({ sources: b.items }));
  const runtime = createDitto({ workers: [createContextWorker()] });
  let saved: GraphCheckpoint | undefined;
  await assert.rejects(runtime.run(plan, "hello", { checkpoint: { version: "v1", save(cp) {
    if (Object.hasOwn(cp.state.outputs, "a")) { saved = cp; throw new Error("simulated process stop"); }
  } } }), /simulated/);
  await runtime.close();
  assert.ok(saved);
  const second = createDitto({ workers: [createContextWorker()] });
  const executed: string[] = [];
  try {
    const result = await runGraph(plan, "hello", async (node, input, scope) => {
      executed.push(scope.nodeId); return second.invoke(node, input as never);
    }, { checkpoint: { version: "v1", resume: JSON.parse(JSON.stringify(saved)), save() {} } });
    assert.deepEqual(executed, ["b", "c"]); assert.equal(result.c.items[0]?.content, "hello");
    await assert.rejects(second.run(plan, "changed input", { checkpoint: { version: "v1", resume: saved, save() {} } }), /incompatible/);
  } finally { await second.close(); }
});

test("checkpoint save is quiescent and failed operations cannot be automatically replayed", async () => {
  const plan = graph<string>("wave")
    .node("a", "CONTEXT.LOAD", [], () => ({ sources: [] }))
    .node("b", "CONTEXT.LOAD", [], () => ({ sources: [] }));
  let active = 0, saved: GraphCheckpoint | undefined;
  await assert.rejects(runGraph(plan, "x", async (_node, _input, scope) => {
    active++; await new Promise(resolve => setTimeout(resolve, scope.nodeId === "a" ? 1 : 5)); active--;
    if (scope.nodeId === "a") throw new Error("uncertain write"); return { items: [] };
  }, { checkpoint: { version: "1", save(cp) { assert.equal(active, 0); saved = cp; } } }), /uncertain write/);
  assert.deepEqual(saved?.state.uncertain, ["a"]);
  await assert.rejects(runGraph(plan, "x", async () => ({}), { checkpoint: { version: "1", resume: saved!, save() {} } }), /uncertain/);
});

test("explicit state loop resumes; generator checkpoint is rejected", async () => {
  const runtime = createDitto({ workers: [createContextWorker()] });
  const plan = graph<number>("increment").node("context", "CONTEXT.LOAD", [], n => ({ sources: [{ role: "user", content: String(n) }] }));
  const definition = { graph: plan, maxIterations: 4, bind: (n: number) => n, update: (n: number) => n + 1, done: (n: number) => n === 3 };
  let saved: StateCheckpoint<LoopCheckpointState> | undefined;
  try {
    await assert.rejects(runtime.loop(definition, 0, { stateCheckpoint: { id: "loop", version: "1", save(cp) { saved = cp; throw new Error("pause"); } } }), /pause/);
    const result = await runtime.loop(definition, 0, { stateCheckpoint: { id: "loop", version: "1", resume: saved!, save() {} } });
    assert.equal(result, 3);
    await assert.rejects(runtime.loop({ id: "generator", *plan() { return 1; } }, undefined,
      { stateCheckpoint: { id: "x", version: "1", save() {} } }), /unsupported/);
  } finally { await runtime.close(); }
});

test("resource namespaces fork atomically, discard and conflict without leaking writes", () => {
  const store = new BranchStore("session"), init = store.fork();
  init.set("memory:k", { value: 1 }); init.set("context:turn", ["start"]); init.commit();
  const a = store.fork(), b = store.fork();
  a.set("memory:k", { value: 2 }); a.set("tool:file", "branch-a");
  assert.deepEqual(b.get("memory:k"), { value: 1 }); a.discard();
  assert.equal(b.get("tool:file"), undefined); b.set("artifact:result", "accepted"); b.commit();
  const restored = new BranchStore("session", JSON.parse(JSON.stringify(store.snapshot()))), reader = restored.fork();
  assert.deepEqual(reader.get("memory:k"), { value: 1 }); assert.equal(reader.get("artifact:result"), "accepted"); reader.discard();
  const x = store.fork(), y = store.fork(); x.set("memory:k", { value: 3 }); x.commit();
  y.set("context:turn", ["stale"]); assert.throws(() => y.commit(), /conflict/); y.discard();
  assert.throws(() => y.get("memory:k"), /closed/);
  assert.deepEqual(store.fork().get("context:turn"), ["start"]);
});

test("concurrent model calls reserve before invocation, settle once, track unknown usage", async () => {
  const budget = new TokenBudget(100); let calls = 0;
  const provider: ModelProvider = { async invoke() { calls++; await new Promise(r => setTimeout(r, 5)); return { message: { role: "assistant", content: "ok" }, finishReason: "stop", usage: { totalTokens: 20 } }; } };
  const wrapped = budgetedProvider(provider, budget, { reserveTokens: () => 80, scope: { runId: "r", branchId: "b" }, requireUsage: true });
  const input = { model: { model: "test" }, messages: [] }, options = { signal: new AbortController().signal };
  const one = wrapped.invoke(input, options);
  await assert.rejects(wrapped.invoke(input, options), BudgetExceededError);
  await one; assert.equal(calls, 1); assert.equal(budget.spent, 20); assert.equal(budget.remaining, 80);
  const settle = budget.reserve(10, { runId: "r" }); settle();
  assert.equal(budget.records[1]?.status, "unknown"); assert.equal(budget.spent, 30);
  assert.throws(() => settle(), /already settled/);
  const exceeded = budget.reserve(5, { runId: "r" }); assert.throws(() => exceeded({ totalTokens: 9 }), /exceeded/); assert.equal(budget.remaining, 0);
});

test("failed requests keep conservative usage and pre-cancelled calls cost nothing", async () => {
  const budget = new TokenBudget(100);
  const provider = budgetedProvider({ async invoke() { throw new Error("transport failed"); } }, budget,
    { reserveTokens: () => 30, scope: { runId: "r" } });
  const input = { model: { model: "test" }, messages: [] };
  await assert.rejects(provider.invoke(input, { signal: AbortSignal.abort() })); assert.equal(budget.spent, 0);
  await assert.rejects(provider.invoke(input, { signal: new AbortController().signal }), /transport failed/);
  assert.equal(budget.spent, 30); assert.equal(budget.records[0]?.status, "unknown");
});
