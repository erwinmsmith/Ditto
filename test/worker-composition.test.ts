import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, defineWorker, graph, NoWorkerAvailableError, type Message } from "../src/index.js";

declare module "../src/contracts/node-contract-map.js" {
  interface NodeContractMap {
    "WORKFLOW.RUN": NodeContract<{ text: string }, Message>;
  }
}

test("mixed Node namespaces execute an internal graph on one replica with shared resources", async () => {
  let replica = 0;
  const runtime = createDitto();
  const plan = graph<string>("internal")
    .node("remember", "MEMORY.RETRIEVE", [], (text) => ({ query: { role: "user", content: text } }))
    .node("think", "REASONING.INFER", ["remember"], (_text, outputs) => ({ messages: outputs.remember.map((row) => row.message) }));
  const worker = defineWorker({ type: "assistant", concurrency: 1, expose: ["WORKFLOW.RUN"],
    resources: () => ({ id: ++replica }),
    nodes: {
      "WORKFLOW.RUN": async (input, ctx) => (await ctx.run(plan, input.text)).think,
      "MEMORY.RETRIEVE": async (_input, ctx) => [{ id: "m", message: { role: "user", content: ctx.resources.id } }],
      "REASONING.INFER": async (input, ctx) => {
        assert.equal(input.messages[0]!.content, ctx.resources.id);
        assert.equal(ctx.execution?.graphId, "internal");
        return { role: "assistant", content: `${ctx.worker.workerId}:${ctx.resources.id}` };
      },
    },
  });
  runtime.register(worker, "a"); runtime.register(worker, "b");
  await assert.rejects(runtime.invoke("REASONING.INFER", { messages: [] }), NoWorkerAvailableError);
  assert.equal((await runtime.invoke("WORKFLOW.RUN", { text: "hello" })).content, "a:1");
  assert.equal((await runtime.invoke("WORKFLOW.RUN", { text: "hello" })).content, "b:2");
  await runtime.close();
});

test("internal graphs validate all capabilities before executing", async () => {
  let calls = 0;
  const runtime = createDitto({ workers: [defineWorker({ type: "frontend", nodes: {
    "WORKFLOW.RUN": async (_input, ctx) => (await ctx.run(graph<void>()
      .node("first", "REASONING.INFER", [], () => ({ messages: [] }))
      .node("missing", "MEMORY.RETRIEVE", [], () => ({ query: { role: "user", content: "" } })), undefined)).first,
    "REASONING.INFER": async () => { calls++; return { role: "assistant", content: "ok" }; },
  } })] });
  await assert.rejects(runtime.invoke("WORKFLOW.RUN", { text: "" }), /does not implement MEMORY/);
  assert.equal(calls, 0);
  await runtime.close();
});

test("busy replicas spill to other workers, overload fails fast, and close drains then disposes once", async () => {
  const gate = Promise.withResolvers<void>();
  let disposed = 0;
  const runtime = createDitto();
  const worker = defineWorker({ type: "assistant", concurrency: 1,
    resources: () => ({ value: 42 }),
    dispose: (resources) => { assert.equal(resources.value, 42); disposed++; },
    nodes: { "REASONING.INFER": async (_input, ctx) => { await gate.promise; return { role: "assistant", content: ctx.worker.workerId }; } },
  });
  const a = runtime.register(worker, "a"); runtime.register(worker, "b");
  const first = runtime.invoke("REASONING.INFER", { messages: [] });
  const second = runtime.invoke("REASONING.INFER", { messages: [] });
  await assert.rejects(runtime.invoke("REASONING.INFER", { messages: [] }), NoWorkerAvailableError);
  const closing = a.close();
  assert.equal(disposed, 0);
  gate.resolve();
  assert.equal((await first).content, "a"); assert.equal((await second).content, "b");
  await closing; await a.close();
  assert.equal(disposed, 1);
  await runtime.close(); assert.equal(disposed, 2);
  await assert.rejects(runtime.invoke("REASONING.INFER", { messages: [] }), /closed/);
  assert.throws(() => runtime.register(worker), /closed/);
});
