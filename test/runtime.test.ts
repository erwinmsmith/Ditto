import assert from "node:assert/strict";
import test from "node:test";
import { createContextWorker, createInMemoryContextStore } from "../src/worker/context/index.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDitto, createRuntimeServices, defineWorker, graph, loadRuntimeConfig, loop,
  LocalEventFabric, type WorkerContext,
} from "../src/index.js";

function worker(handler: (input: string, ctx: WorkerContext) => Promise<string>, concurrency = 1, dispose?: () => void) {
  return defineWorker({ type: "MEMORY", concurrency, ...(dispose ? { dispose } : {}), nodes: {
    "MEMORY.GET": async ({ ids }, ctx) => ({ executionId: "test", node: "MEMORY.GET", status: "success",
      output: [{ id: ids![0]!, content: await handler(ids![0]!, ctx) }] }),
  } });
}
const read = (id: string) => ({ ids: [id] });

test("graph bindings select replicas, preserve scoped services, and validate before effects", async () => {
  const seen: string[] = [];
  const definition = worker(async (id, ctx) => {
    seen.push(ctx.worker.workerId);
    assert.equal(ctx.services.sandbox.allows("tools", id), true);
    assert.equal(ctx.services.sandbox.allows("tools", id === "a" ? "b" : "a"), false);
    assert.equal(ctx.execution?.nodeId, id);
    return ctx.worker.workerId;
  });
  const runtime = createDitto();
  for (const id of ["a", "b"]) runtime.register(definition, { id, services: createRuntimeServices({ sandbox: { tools: [id] } }) });
  const plan = graph<void>().node("a", "MEMORY.GET", [], () => read("a"))
    .node("b", "MEMORY.GET", ["a"], (_input, { a }) => read(a.output![0]!.content === "a" ? "b" : "wrong"));
  try {
    await assert.rejects(runtime.run(plan, undefined, { workers: { missing: "a" } }), /Unknown graph Node/);
    assert.deepEqual(seen, []);
    const output = await runtime.run(plan, undefined, { workers: { a: "a", b: "b" } });
    assert.equal(output.b.output![0]!.content, "b");
    assert.deepEqual(seen, ["a", "b"]);
  } finally { await runtime.close(); }
});

test("ready queue bounds parallel work and waits for running siblings on failure", async () => {
  let active = 0, peak = 0;
  const completed: string[] = [];
  const runtime = createDitto({ config: loadRuntimeConfig({}, { runtime: { graphConcurrency: 2 } }), workers: [worker(async id => {
    active++; peak = Math.max(peak, active);
    try {
      if (id === "fail") throw new Error("node failed");
      await delay(10); completed.push(id); return id;
    } finally { active--; }
  }, 2)] });
  try {
    const plan = graph<void>().node("one", "MEMORY.GET", [], () => read("one"))
      .node("two", "MEMORY.GET", [], () => read("two"))
      .node("join", "MEMORY.GET", ["one", "two"], () => read("join"));
    await runtime.run(plan, undefined);
    assert.equal(peak, 2); assert.equal(completed.at(-1), "join");
    completed.length = 0;
    const failed = graph<void>().node("a", "MEMORY.GET", [], () => read("fail"))
      .node("b", "MEMORY.GET", [], () => read("running"))
      .node("c", "MEMORY.GET", [], () => read("not-started"));
    await assert.rejects(runtime.run(failed, undefined), /node failed/);
    assert.deepEqual(completed, ["running"]); assert.equal(active, 0);
  } finally { await runtime.close(); }
});

test("close drains accepted graph and nested worker invokes before disposal, once", async () => {
  let disposed = 0;
  const runtime = createDitto();
  runtime.register(worker(async () => {
    await delay(5); assert.equal(disposed, 0); return "finished";
  }, 1, () => { disposed++; }), "reader");
  runtime.register(defineWorker({ type: "CONTEXT", nodes: {
    "CONTEXT.LOAD": async (_input, ctx) => {
      const result = await ctx.invoke("MEMORY.GET", read("nested"), { workerId: "reader" });
      return { items: [{ id: "nested", content: String(result.output![0]!.content) }] };
    },
  } }));
  const plan = graph<void>().node("first", "MEMORY.GET", [], () => read("first"))
    .node("next", "CONTEXT.LOAD", ["first"], () => ({ sources: [] }));
  const running = runtime.run(plan, undefined);
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  await assert.rejects(runtime.invoke("MEMORY.GET", read("late")), /closed/);
  assert.equal((await running).next.items[0]?.content, "finished");
  await closing; assert.equal(disposed, 1);
});

test("cancellation propagates to handlers, drains them, and prevents subsequent nodes", async () => {
  const controller = new AbortController();
  let completed = false, calls = 0;
  const runtime = createDitto({ workers: [worker(async (_id, ctx) => {
    calls++; assert.equal(ctx.signal, controller.signal);
    controller.abort(new Error("stop graph"));
    await delay(5); completed = true; return "done";
  })] });
  try {
    const plan = graph<void>().node("a", "MEMORY.GET", [], () => read("a"))
      .node("b", "MEMORY.GET", ["a"], () => read("b"));
    await assert.rejects(runtime.run(plan, undefined, { signal: controller.signal }), /stop graph/);
    assert.equal(calls, 1); assert.equal(completed, true);
  } finally { await runtime.close(); }
});

test("loop selects different graphs and per-graph worker bindings; config sets iteration budget", async () => {
  const seen: string[] = [];
  const runtime = createDitto({ config: loadRuntimeConfig({}, { runtime: { loopMaxIterations: 3 } }) });
  const definition = worker(async (id, ctx) => { seen.push(`${ctx.execution!.graphId}:${ctx.worker.workerId}:${id}`); return id; });
  runtime.register(definition, "a"); runtime.register(definition, "b");
  const plan = (id: string) => graph<number>(id).node("read", "MEMORY.GET", [], n => read(String(n)));
  const first = plan("first"), second = plan("second");
  const workflow = loop({ graph: (state: number) => state % 2 ? second : first,
    bind: (state: number) => state, update: (state: number) => state + 1, done: (state: number) => state === 3 });
  try {
    assert.equal(await runtime.loop(workflow, 0, { workers: { first: { read: "a" }, second: { read: "b" } } }), 3);
    assert.deepEqual(seen, ["first:a:0", "second:b:1", "first:a:2"]);
    await assert.rejects(runtime.loop({ ...workflow, done: () => false }, 0), /iteration limit/);
  } finally { await runtime.close(); }
});

test("closing a runtime removes only its event subscriptions and drains accepted handlers", async () => {
  const events = new LocalEventFabric();
  const first = createDitto({ events }), second = createDitto({ events });
  let a = 0, b = 0;
  first.subscribe("tick", async () => { await delay(5); a++; });
  second.subscribe("tick", () => { b++; });
  await first.emit({ type: "tick", payload: null });
  await first.close(); assert.equal(a, 1);
  await assert.rejects(first.emit({ type: "tick", payload: null }), /closed/);
  await second.emit({ type: "tick", payload: null }); await second.drainEvents();
  assert.equal(a, 1); assert.equal(b, 2); await second.close();
});

test("bindings are strict, graph IDs do not inherit object properties, and invalid budgets fail before execution", async () => {
  let calls = 0;
  const runtime = createDitto();
  const definition = worker(async id => { calls++; return id; });
  const a = runtime.register(definition, "a"); runtime.register(definition, "b");
  const plan = graph<void>().node("constructor", "MEMORY.GET", [], () => read("value"));
  try {
    await runtime.run(plan, undefined);
    assert.equal(calls, 1);
    a.setAvailable(false);
    await assert.rejects(runtime.run(plan, undefined, { workers: { constructor: "a" } }), /No available Worker/);
    assert.equal(calls, 1);
    for (const concurrency of [0, -1, 1.5, NaN]) await assert.rejects(runtime.run(plan, undefined, { concurrency }), /concurrency/);
    const controller = new AbortController(); controller.abort(new Error("already cancelled"));
    await assert.rejects(runtime.run(plan, undefined, { signal: controller.signal }), /already cancelled/);
    for (const settings of [{ graphConcurrency: 0 }, { loopMaxIterations: 1.5 }]) {
      assert.throws(() => loadRuntimeConfig({}, { runtime: settings }), /must be an integer/);
    }
    assert.equal(calls, 1);
  } finally { await runtime.close(); }
});

test("Loop plans own multi-Graph sequencing, branching, recovery and repeated Graph execution", async () => {
  const { graphStep } = await import("../src/runtime/index.js");
  const first = graph<{ text: string }>("plan-first").node(
    "context",
    "CONTEXT.LOAD",
    [],
    (i) => ({ sources: [{ id: "text", content: i.text }] }),
  );
  const second = graph<{
    context: import("../src/contracts/index.js").Context;
  }>("plan-second").node("context", "CONTEXT.UPDATE", [], (i) => ({
    context: i.context,
    add: [{ id: "second", content: "processed" }],
  }));
  const runtime = createDitto({
    workers: [
      createContextWorker({
        services: { stateStore: createInMemoryContextStore() },
      }),
    ],
  });
  const events: import("../src/runtime/index.js").LoopGraphEvent[] = [];
  const definition = loop({
    id: "composed",
    maxIterations: 3,
    plan: function* (text: string) {
      let result = yield* graphStep(first, { text });
      for (let i = 0; i < 2; i++)
        result = yield* graphStep(second, { context: result.context });
      return result.context;
    },
  });
  try {
    const result = await runtime.loop(definition, "input", {
      onGraph: (event) => events.push(event),
    });
    assert.equal(result.items.length, 2);
    assert.deepEqual(
      events.filter((e) => e.status === "started").map((e) => e.graphId),
      ["plan-first", "plan-second", "plan-second"],
    );
    await assert.rejects(
      runtime.loop({ ...definition, maxIterations: 2 }, "input"),
      /iteration limit/,
    );
    const recovery = loop({
      id: "recovery-plan",
      plan: function* () {
        try {
          yield* graphStep(
            graph("unavailable").node("missing", "MEMORY.GET", [], () => ({
              keys: ["missing"],
            })),
            {},
          );
        } catch {
          return (yield* graphStep(first, { text: "recovered" })).context;
        }
        throw new Error("Expected missing Worker");
      },
    });
    assert.equal(
      (await runtime.loop(recovery, undefined)).items[0]!.content,
      "recovered",
    );
  } finally {
    await runtime.close();
  }
});

test("Loop plan cancellation and iteration budgets cannot be swallowed; close drains active Graphs", async () => {
  const { graphStep } = await import("../src/runtime/index.js");
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0,
    disposed = false;
  const worker = defineWorker({
    type: "CONTEXT",
    nodes: {
      "CONTEXT.LOAD": async () => {
        calls++;
        entered();
        await waiting;
        return { items: [] };
      },
    },
    dispose() {
      disposed = true;
    },
  });
  const runtime = createDitto({ workers: [worker] });
  const operation = graph("wait").node("result", "CONTEXT.LOAD", [], () => ({
    sources: [],
  }));
  const definition = loop({
    id: "cancel-plan",
    plan: function* () {
      try {
        yield* graphStep(operation, {});
      } catch {
        yield* graphStep(operation, {});
      }
      return "done";
    },
  });
  const controller = new AbortController();
  const running = runtime.loop(definition, undefined, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(running);
  await started;
  const closing = runtime.close();
  assert.equal(disposed, false);
  controller.abort();
  finish();
  await rejected;
  await closing;
  assert.equal(calls, 1);
  assert.equal(disposed, true);
});

test("Loop plans retain Worker bindings and recover stage cancellation within one shared budget", async () => {
  const { graphStep } = await import("../src/runtime/index.js");
  const seen: string[] = [];
  const runtime = createDitto({
    config: loadRuntimeConfig({}, { runtime: { loopMaxIterations: 2 } }),
  });
  const definition = worker(async (id, context) => {
    seen.push(context.worker.workerId);
    return id;
  });
  runtime.register(definition, "first");
  runtime.register(definition, "second");
  const operation = graph<string>("bound").node("read", "MEMORY.GET", [], read);
  const events: string[] = [];
  const workflow = loop({
    id: "stage-recovery",
    plan: function* () {
      try {
        yield* graphStep(operation, "cancelled", {
          signal: AbortSignal.abort(new Error("stage deadline")),
        });
      } catch {
        return yield* graphStep(operation, "recovered");
      }
      throw new Error("Expected stage failure");
    },
  });
  try {
    await runtime.loop(workflow, undefined, {
      workers: { bound: { read: "second" } },
      onGraph: (event) => events.push(event.status),
    });
    assert.deepEqual(seen, ["second"]);
    assert.deepEqual(events, ["started", "failed", "started", "completed"]);
    seen.length = 0;
    await assert.rejects(
      runtime.loop({ ...workflow, maxIterations: 1 }, undefined),
      /iteration limit/,
    );
    assert.deepEqual(seen, []);
    let cleaned = false;
    const endless = loop({
      id: "budget-cannot-be-caught",
      maxIterations: 1,
      plan: function* () {
        try {
          while (true) {
            try {
              yield* graphStep(operation, "repeat");
            } catch {
              /* Graph failures may be recovered. */
            }
          }
        } finally {
          cleaned = true;
        }
      },
    });
    await assert.rejects(runtime.loop(endless, undefined), /iteration limit/);
    assert.equal(cleaned, true);
    assert.equal(seen.length, 1);
  } finally {
    await runtime.close();
  }
});
