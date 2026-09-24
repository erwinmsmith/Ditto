# Worker composition, events and Artifact API

[English / 简体中文](composition.zh-CN.md) · [Runtime](runtime.md) · [API](README.md)

This reference covers application extension interfaces. See [Runtime](runtime.md) for graphs, loops, placement, cancellation and Sandbox, and [configuration](configuration.md) for loaders. Complete code uses public exports in [api.ts](examples/runtime/api.ts); run `npm run example:runtime:api`. Importing the file performs no requests.

## Node and Worker definitions

`NodeContract<I,O>` describes input/output. Extend `NodeContractMap` through TypeScript declaration merging; `NodeType` is the union of declared keys and `InputOf<N>` / `OutputOf<N>` infer their data. Types do not generate handlers or validate network input at runtime; handlers must validate input themselves.

| API | Arguments, result and behavior |
| --- | --- |
| `defineNode<N,R,C>(workerType, type, execute)` | Immutable NodeDefinition with workerType/type/execute; handler is `(input, ctx) => Promise<OutputOf<N>>` |
| `createNodeScaffold(type)` | Descriptor with type/define; `.define<R,C>(workerType, handler)` is equivalent to defineNode and does not register anything |
| `defineWorker<R,C>(options)` | Reusable WorkerDefinition; requires at least one implemented and exposed node; ownership and node keys must match |
| `extendWorker<T,R,C>(type, options)` | Qualifies relative operation keys with `${type}.`; creates a new definition without mutating an existing Worker |
| `definition.type/capabilities/nodeTypes/concurrency` | Deployment type, public nodes, all implemented nodes and optional capacity; used for registration/routing |
| `definition.instantiate()` | Returns a WorkerExecutor with execute(node,input,context) and optional dispose; normal applications let runtime.register manage these calls |

`WorkerOptions` requires `type/nodes`. `resources?: () => R` runs once per registration; `config?: C` supplies business configuration. When R/C are specified, their corresponding fields are required. `concurrency` is a positive integer, unlimited by default; `expose` defaults to all nodes; `dispose(resources)` may be asynchronous. The resource factory is synchronous, but resources may contain a connection Promise awaited by handlers. Applications close shared SDK clients; dispose can close replica-owned clients.

Imports for these examples:

```ts
import assert from "node:assert/strict";
import type { NodeContract } from "@codesoul-co/ditto/contracts";
import { createNodeScaffold, defineNode, defineWorker, extendWorker } from "@codesoul-co/ditto/worker";
import {
  createDitto, graph, InMemoryArtifactStore, LocalEventFabric,
  NoWorkerAvailableError, PayloadCodec,
} from "@codesoul-co/ditto/runtime";
```

```ts
declare module "@codesoul-co/ditto/contracts" {
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
```

Both nodes belong to the `text` Worker; only PROCESS is exposed. PROCESS calls private NORMALIZE through ctx.run, sharing this replica’s counter/configuration. Two registrations get separate counters. Config is not deep-copied; applications should treat it as immutable.

Relative operation names:

```ts
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
```

## WorkerContext and lifecycle

| Member | Use |
| --- | --- |
| `ctx.resources`, `ctx.config` | Current replica resources and definition-provided business configuration |
| `ctx.services` | config/providers/sandbox supplied by Runtime or registration-specific services |
| `ctx.worker`, `ctx.execution` | WorkerAddress; optional graphId/runId/nodeId; a top-level invoke has no Graph scope |
| `ctx.signal` | Local cooperative cancellation; forward to SDK/Sandbox calls |
| `ctx.run(plan,input)` | Internal graph on this replica, including private nodes, without another entry-capacity reservation |
| `ctx.invoke(node,input,options?)` | Public capability routing with optional workerId/signal; inherits execution scope and cancellation |
| `ctx.emit(event)` | Event submission; awaiting it acknowledges acceptance rather than consumer completion |
| `ctx.artifacts` | Optional ArtifactStore, present only when configured on Runtime |

WorkerContext implements RuntimeClient (invoke/emit) and can be passed to predefined Context flows. Await internal work; do not await this handler’s own handle.close/runtime.close. Definitions participate in Runtime scheduling only after registration.

This example checks private-node visibility, separate replica resources, pause/resume, unregister and idempotent cleanup:

```ts
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
```

`NoWorkerAvailableError.node` identifies an unavailable capability: missing/private/paused Workers or exhausted capacity can all cause it. There is no implicit queue or retry. Business failure objects remain ordinary Graph outputs; inspect status and decide whether to throw. unregister does not dispose resources; close is still required.

## EventFabric

Inject `new LocalEventFabric()` with `createDitto({ events })`. `RuntimeEvent<T>` is `{type,payload}`. `subscribe(type,handler)` matches the exact type and returns an unsubscribe function (true once removed, then false). `emit(event)` acknowledges acceptance; consumers run independently. `drain()` waits for submitted work, including events emitted by consumers, then returns and clears `{event,error}[]`. Runtime exposes emit/subscribe/drainEvents for the same operations.

```ts
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
```

LocalEventFabric is an in-process asynchronous broadcast with no persistence, network delivery, capacity limit or retry. Applications bound producers and drain regularly. A custom EventFabric implements emit/subscribe/drain; Runtime.close does not close an external shared bus. HTTP/IPC invocation is separate from events.

## ArtifactStore and PayloadCodec

| API | Input, output and semantics |
| --- | --- |
| `new InMemoryArtifactStore()` | Process-local Map without TTL, capacity limits or persistence |
| `store.put(value)` | Promise<Reference>, creating ditto://artifact/...; retains the original object identity |
| `store.get(reference)` | Promise<unknown>; missing references throw; callers validate the value |
| `store.delete(reference)` | Promise<boolean>, whether an existing entry was removed |
| `new PayloadCodec(store?, inlineLimitBytes?)` | Defaults to 65536 bytes; finite nonnegative threshold |
| `codec.encode(value)` | Promise<Payload>; with a store, JSON UTF-8 size above threshold produces a reference, otherwise inline |
| `codec.decode(payload)` | Inline returns value; reference calls store.get and throws if no store exists |

```ts
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
```

Inject with `createDitto({ artifacts: store, inlineLimitBytes: 65536 })`. Direct calls bypass encoding; only transport boundaries use the codec. Both processes must access the same external storage; separate InMemoryArtifactStore instances do not share data. Core does not reclaim transport references; the application/store owns cleanup, authorization and expiry. Payload references do not automatically become a CONTEXT ReferenceResolver; connect those interfaces explicitly if needed.

## Custom communication adapters

Prefer the supplied [IPC / HTTP APIs](runtime.md#ipc-and-http-adapters). A custom `InvokeTransport` implements `id` and `invoke(envelope, {signal}?) => Promise<InvocationResult>`. An authenticated receiver calls `runtime.receive(envelope)` and preserves the invocationId. Envelopes contain id/node/target/payload and optional source/execution; target is a complete WorkerAddress. The adapter owns authentication, serialization, timeouts and error mapping; receive itself is not a network server.

Wrap an application-owned, authenticated RPC client as follows:

```ts
import type { InvocationEnvelope, InvocationResult, InvokeTransport } from "@codesoul-co/ditto/runtime";

export function adaptRpc(request: (
  envelope: InvocationEnvelope, signal?: AbortSignal,
) => Promise<InvocationResult>): InvokeTransport {
  return { id: "application-rpc", invoke: (envelope, options) => request(envelope, options?.signal) };
}
```

Then use `createDitto({ transports: [adaptRpc(request)] })` and `registerRemote({address,capabilities,transportId:"application-rpc"})` for an already deployed Worker; request is the connected application client function. See [placement.ts](examples/runtime/placement.ts) for complete address exchange and cleanup.
