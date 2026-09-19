import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, defineWorker, graph, loop, mergeContextUpdate, type Message } from "../src/index.js";

const user: Message = { role: "user", content: "hello" };

test("Runtime routes final Node contracts and executes a location-free Graph", async () => {
  const runtime = createDitto({ workers: [
    defineWorker({ type: "MEMORY", nodes: {
      "MEMORY.RETRIEVE": async ({ selector }) => selector.ids?.map((id) => ({ id, message: user })) ?? [],
    } }),
    defineWorker({ type: "CONTEXT", nodes: { "CONTEXT.UPDATE": mergeContextUpdate } }),
  ] });
  const plan = graph<{ id: string }>("restore-memory")
    .node("memory", "MEMORY.RETRIEVE", [], ({ id }) => ({ selector: { ids: [id] } }))
    .node("context", "CONTEXT.UPDATE", ["memory"], (_input, output) => ({
      context: { items: [] },
      add: output.memory.map((memory) => ({ id: memory.id, content: memory.message.content })),
    }));
  const output = await runtime.run(plan, { id: "m1" });
  assert.deepEqual(output.context.items, [{ id: "m1", content: "hello" }]);
});

test("Runtime owns repeated execution while Nodes remain single-step", async () => {
  const runtime = createDitto({ workers: [defineWorker({ type: "MEMORY", nodes: {
    "MEMORY.RETRIEVE": async ({ selector }) => selector.ids?.map((id) => ({ id, message: user })) ?? [],
  } })] });
  const plan = graph<number>("count").node("memory", "MEMORY.RETRIEVE", [], (value) => ({ selector: { ids: [String(value)] } }));
  const result = await runtime.loop(loop({
    graph: plan,
    maxIterations: 3,
    bind: (state: number) => state,
    update: (state) => state + 1,
    done: (state) => state === 3,
  }), 0);
  assert.equal(result, 3);
});
