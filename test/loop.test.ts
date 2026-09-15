import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, extendWorker, graph, loop, type ExecutionScope, type LoopDefinition, type Message } from "../src/index.js";

const step = graph<number>("increment").node("value", "INTERACTION.OUTPUT", [], (value) => ({
  message: { role: "assistant", content: String(value + 1) },
}));

test("Loop binds updated state, waits for each Graph, and returns the state that satisfies done", async () => {
  const scopes: ExecutionScope[] = [];
  const runtime = createDitto({ workers: [extendWorker("INTERACTION", { nodes: {
    OUTPUT: async ({ message }, ctx) => { scopes.push(ctx.execution!); return message; },
  } })] });
  const seen: number[] = [];
  const definition = loop({ graph: step, maxIterations: 3, bind: (state: number) => { seen.push(state); return state; },
    update: (_state, { value }) => Number(value.content), done: (state) => state === 3,
  });
  try {
    assert.equal(await runtime.loop(definition, 0), 3);
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(new Set(scopes.map((scope) => scope.runId)).size, 3);
    assert.ok(scopes.every((scope) => scope.graphId === "increment" && scope.nodeId === "value"));
    assert.ok(Object.isFrozen(definition));
  } finally { await runtime.close(); }
});

test("Loop enforces its default limit and rejects invalid limits before callbacks or effects", async () => {
  const runtime = createDitto();
  let iterations = 0;
  const definition = { graph: graph<number>(), bind: (state: number) => { iterations++; return state; },
    update: (state: number) => state + 1, done: () => false,
  };
  try {
    await assert.rejects(runtime.loop(definition, 0), /Loop iteration limit reached/);
    assert.equal(iterations, 32);
    iterations = 0;
    for (const maxIterations of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(runtime.loop({ ...definition, maxIterations }, 0), /positive integer/);
    }
    assert.equal(iterations, 0);
    await assert.rejects(runtime.loop({ ...definition, maxIterations: 2 }, 0), /iteration limit/);
    assert.equal(iterations, 2);
  } finally { await runtime.close(); }
});

test("Loop propagates Graph and callback failures without retrying or advancing", async () => {
  const failure = new Error("original failure");
  let effects = 0;
  let updates = 0;
  const runtime = createDitto({ workers: [extendWorker("INTERACTION", { nodes: {
    OUTPUT: async () => { effects++; throw failure; },
  } })] });
  const definition = { graph: step, bind: (state: number) => state,
    update: (state: number) => { updates++; return state; }, done: () => false,
  };
  try {
    await assert.rejects(runtime.loop(definition, 0), (error) => error === failure);
    assert.equal(effects, 1); assert.equal(updates, 0);
    for (const callback of ["bind", "update", "done"] as const) {
      await assert.rejects(runtime.loop({ ...definition, graph: graph<number>(),
        [callback]: () => { throw failure; },
      }, 0), (error) => error === failure);
    }
    assert.equal(effects, 1);
  } finally { await runtime.close(); }
});

test("Loop executions share a definition while keeping their state separate", async () => {
  const runtime = createDitto({ workers: [extendWorker("INTERACTION", { nodes: {
    OUTPUT: async ({ message }) => message,
  } })] });
  const definition = loop({ graph: step, bind: (state: { value: number; turns: number }) => state.value,
    update: (state, { value }) => ({ value: Number(value.content), turns: state.turns + 1 }),
    done: (state) => state.turns === 2,
  });
  const initial = { value: 0, turns: 0 };
  try {
    assert.deepEqual(await Promise.all([
      runtime.loop(definition, initial), runtime.loop(definition, { value: 10, turns: 0 }),
    ]), [{ value: 2, turns: 2 }, { value: 12, turns: 2 }]);
    assert.deepEqual(initial, { value: 0, turns: 0 });
  } finally { await runtime.close(); }
});

test("Loop selects a different DAG from the latest state on each iteration", async () => {
  interface State { phase: "prepare" | "finish"; value: number }
  const selected: string[] = [];
  const executed: string[] = [];
  const prepare = graph<State>("prepare")
    .node("left", "INTERACTION.OUTPUT", [], (state) => ({ message: { role: "user", content: String(state.value) } }))
    .node("right", "INTERACTION.OUTPUT", [], () => ({ message: { role: "user", content: "2" } }))
    .node("value", "INTERACTION.OUTPUT", ["left", "right"], (_state, { left, right }) => ({
      message: { role: "assistant", content: String(Number(left.content) + Number(right.content)) },
    }));
  const finish = graph<State>("finish").node("value", "INTERACTION.OUTPUT", [], (state) => ({
    message: { role: "assistant", content: String(state.value * 10) },
  }));
  const runtime = createDitto({ workers: [extendWorker("INTERACTION", { nodes: {
    OUTPUT: async ({ message }, ctx) => { executed.push(`${ctx.execution!.graphId}:${ctx.execution!.nodeId}`); return message; },
  } })] });
  const graphs = { prepare, finish };
  const definition = loop({
    graph: (state: State) => { selected.push(state.phase); return graphs[state.phase]; },
    bind: (state: State) => state,
    update: (state, { value }): State => ({ phase: state.phase === "prepare" ? "finish" : "prepare", value: Number(value.content) }),
    done: (state) => state.value === 32,
  });
  try {
    assert.deepEqual(await runtime.loop(definition, { phase: "prepare", value: 1 }), { phase: "finish", value: 32 });
    assert.deepEqual(selected, ["prepare", "finish", "prepare"]);
    assert.deepEqual(executed, ["prepare:left", "prepare:right", "prepare:value", "finish:value",
      "prepare:left", "prepare:right", "prepare:value"]);
    const failure = new Error("selection failed");
    await assert.rejects(runtime.loop({ ...definition, graph: () => { throw failure; } }, { phase: "prepare", value: 1 }),
      (error) => error === failure);
    assert.equal(executed.length, 7);
  } finally { await runtime.close(); }
});

test("closed Runtime rejects a Loop before bind; closing between iterations prevents the next Graph", async () => {
  const runtime = createDitto();
  let binds = 0;
  const definition = { graph: graph<number>(), bind: (state: number) => { binds++; return state; },
    update: (state: number) => { void runtime.close(); return state + 1; }, done: () => false,
  };
  await assert.rejects(runtime.loop(definition, 0), /Runtime is closed/);
  const previous = binds;
  await assert.rejects(runtime.loop(definition, 0), /Runtime is closed/);
  assert.equal(binds, previous);
});

test("selected DAGs can expose different result shapes through a typed union", async () => {
  const first = graph<number>().node("draft", "INTERACTION.OUTPUT", [], () => ({ message: { role: "user", content: "draft" } }));
  const second = graph<number>().node("answer", "INTERACTION.OUTPUT", [], () => ({ message: { role: "assistant", content: "answer" } }));
  const outputs: string[] = [];
  const definition: LoopDefinition<number, number, { draft: Message } | { answer: Message }> = {
    graph: (state) => state === 0 ? first : second,
    bind: (state) => state,
    update: (state, output) => { outputs.push(String("draft" in output ? output.draft.content : output.answer.content)); return state + 1; },
    done: (state) => state === 2,
  };
  const runtime = createDitto({ workers: [extendWorker("INTERACTION", { nodes: { OUTPUT: async ({ message }) => message } })] });
  try {
    assert.equal(await runtime.loop(definition, 0), 2);
    assert.deepEqual(outputs, ["draft", "answer"]);
  } finally { await runtime.close(); }
});
