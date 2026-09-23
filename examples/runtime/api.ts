import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { NodeContract } from "@ditto/core/contracts";
import { createNodeScaffold, defineNode, defineWorker, extendWorker } from "@ditto/core/worker";
import {
  createDitto, graph, InMemoryArtifactStore, LocalEventFabric,
  NoWorkerAvailableError, PayloadCodec,
} from "@ditto/core/runtime";

// example: workerDefinition
declare module "@ditto/core/contracts" {
  interface NodeContractMap {
    "EXAMPLE.TEXT.NORMALIZE": NodeContract<{ text: string }, { text: string; calls: number }>;
    "EXAMPLE.TEXT.PROCESS": NodeContract<{ text: string }, { text: string; calls: number }>;
  }
}

type Resources = { calls: number };
type Config = { prefix: string };
const internal = graph<string>("normalize-internal")
  .node("normalized", "EXAMPLE.TEXT.NORMALIZE", [], text => ({ text }));

export function textWorker(onDispose: (calls: number) => void) {
  const normalize = createNodeScaffold("EXAMPLE.TEXT.NORMALIZE").define<Resources, Config>(
    "text", async ({ text }, ctx) => {
      ctx.signal?.throwIfAborted();
      if (typeof text !== "string") throw new TypeError("text must be a string");
      return { text: `${ctx.config.prefix}${text.trim().toUpperCase()}`, calls: ++ctx.resources.calls };
    },
  );
  const processText = defineNode<"EXAMPLE.TEXT.PROCESS", Resources, Config>(
    "text", "EXAMPLE.TEXT.PROCESS", async ({ text }, ctx) => {
      const output = await ctx.run(internal, text);
      await ctx.emit({ type: "text.processed", payload: output.normalized });
      return output.normalized;
    },
  );
  return defineWorker<Resources, Config>({
    type: "text", concurrency: 2,
    resources: () => ({ calls: 0 }), config: { prefix: "Ditto: " },
    expose: ["EXAMPLE.TEXT.PROCESS"],
    nodes: { "EXAMPLE.TEXT.NORMALIZE": normalize, "EXAMPLE.TEXT.PROCESS": processText },
    dispose: resources => onDispose(resources.calls),
  });
}

// example: scopedDefinition
export function simpleTextWorker() {
  return extendWorker<"EXAMPLE.TEXT">("EXAMPLE.TEXT", {
    nodes: {
      NORMALIZE: async ({ text }) => {
        if (typeof text !== "string") throw new TypeError("text must be a string");
        return { text: text.trim().toUpperCase(), calls: 1 };
      },
    },
  });
}

// example: workerLifecycle
export async function workerLifecycle() {
  const disposed: number[] = [];
  const runtime = createDitto();
  const definition = textWorker(calls => { disposed.push(calls); });
  const first = runtime.register(definition, "text-a");
  const second = runtime.register(definition, { id: "text-b" });
  const events: unknown[] = [];
  const unsubscribe = runtime.subscribe("text.processed", event => { events.push(event.payload); });
  try {
    const plan = runtime.graph<string>("text-entry")
      .node("result", "EXAMPLE.TEXT.PROCESS", [], text => ({ text }));
    const output = await runtime.run(plan, " hello ", { workers: { result: "text-a" } });
    assert.deepEqual(output.result, { text: "Ditto: HELLO", calls: 1 });
    const replica = await runtime.invoke("EXAMPLE.TEXT.PROCESS", { text: "world" }, { workerId: "text-b" });
    assert.equal(replica.calls, 1); // Separate resources for each registration.
    await assert.rejects(runtime.invoke("EXAMPLE.TEXT.NORMALIZE", { text: "private" }), NoWorkerAvailableError);
    second.setAvailable(false);
    assert.equal(runtime.workers().find(worker => worker.address.workerId === "text-b")?.available, false);
    await assert.rejects(runtime.invoke("EXAMPLE.TEXT.PROCESS", { text: "paused" }, { workerId: "text-b" }), NoWorkerAvailableError);
    second.setAvailable(true);
    assert.equal(second.unregister(), true); // Resources still exist until close.
    assert.equal(disposed.length, 0);
    await second.close();
    assert.deepEqual(await runtime.drainEvents(), []);
    assert.equal(events.length, 2);
    assert.equal(unsubscribe(), true);
    await first.close();
    return { output: output.result, events, disposed };
  } finally {
    unsubscribe();
    await runtime.close(); // Idempotent; both handles are already closed on success.
    assert.deepEqual(disposed, [1, 1]);
  }
}

// example: eventFabric
export async function eventFabric() {
  const events = new LocalEventFabric();
  const seen: unknown[] = [];
  const unsubscribe = events.subscribe("job.done", event => { seen.push(event.payload); });
  const unsubscribeFailure = events.subscribe("job.done", () => { throw new Error("consumer unavailable"); });
  await events.emit({ type: "job.done", payload: { id: "job-1" } });
  const failures = await events.drain();
  assert.equal(failures.length, 1);
  assert.deepEqual(seen, [{ id: "job-1" }]);
  assert.deepEqual(await events.drain(), []); // Failure records have been consumed.
  unsubscribe();
  unsubscribeFailure();
  return { seen, failedConsumers: failures.length };
}

// example: artifacts
export async function artifacts() {
  const store = new InMemoryArtifactStore();
  const value = { text: "x".repeat(100) };
  const reference = await store.put(value);
  assert.strictEqual(await store.get(reference), value); // No clone or persistence.
  assert.equal(await store.delete(reference), true);
  assert.equal(await store.delete(reference), false);
  await assert.rejects(store.get(reference), /Artifact not found/);

  const codec = new PayloadCodec(store, 32);
  const small = await codec.encode({ text: "ok" });
  const large = await codec.encode(value);
  assert.equal(small.kind, "inline");
  assert.equal(large.kind, "reference");
  assert.deepEqual(await codec.decode(small), { text: "ok" });
  assert.deepEqual(await codec.decode(large), value);
  if (large.kind === "reference") await store.delete(large.reference);
  return { small: small.kind, large: large.kind };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await workerLifecycle());
  console.log(await eventFabric());
  console.log(await artifacts());
  const runtime = createDitto({ workers: [simpleTextWorker()] });
  try {
    assert.deepEqual(await runtime.invoke("EXAMPLE.TEXT.NORMALIZE", { text: " hello " }), { text: "HELLO", calls: 1 });
  } finally { await runtime.close(); }
}
