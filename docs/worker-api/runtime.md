# Runtime, Graph and Loop API

[简体中文](runtime.zh-CN.md) · [Worker API](README.md) · [Runnable examples](../../examples/runtime/README.md)

Import Runtime APIs from `@ditto/core` or `@ditto/core/runtime`. Define the graph's nodes and dependencies, define loop state transitions, register concrete Workers, then execute. Model, database and tool plugins stay inside their Workers.

## Placement and communication

| Worker placement | Execution | Registration |
| --- | --- | --- |
| Same process | Direct call; no serialization | `register(definition)` |
| Same machine, separate process | Native Node IPC; no TCP socket | `createIpcTransport` + `registerRemote`; receiver uses `serveWorkerIpc` |
| Separate machines | HTTP(S) request/response | `createHttpTransport` + `registerRemote`; receiver uses `createWorkerHttpHandler` |

Routing filters public capabilities, availability and capacity, then prefers direct execution, same host, and other hosts, with round robin among peers. Each external registration names an installed transport. Runtime does not launch processes or discover endpoints. Use the same `hostId` for one machine and distinct `processId` values for its runtimes; Worker IDs must be unique within a caller's directory.

Local IPC / network HTTP are deployment modes. Separately, `invoke` means request/response and `emit` means asynchronous event acceptance. Events stay within the injected EventFabric; invoking a Worker through IPC/HTTP does not broadcast events. See [communication](../worker-communication.md) for credentials and Artifact storage.

## Creation, registration and cleanup

```ts
import { createDitto, createContextWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, hostId: "machine-a", processId: "agent" });
const context = runtime.register(createContextWorker(), "context-a");
try {
  console.log(runtime.workers());
  console.log(await runtime.invoke("CONTEXT.LOAD", {
    sources: [{ role: "user", content: "hello" }],
  }, { workerId: context.address.workerId }));
} finally { await runtime.close(); }
```

| API | Arguments and behavior |
| --- | --- |
| `createDitto(options?)` / `new DittoRuntime(options?)` | `config/providers/sandbox/sandboxExecutor` build default services; `workers` registers definitions; `hostId/processId` identify the runtime; `transports/events/artifacts/inlineLimitBytes` inject communication resources |
| `register(worker, idOrOptions?)` | Returns a WorkerHandle; second argument is an ID or `{ id?, services? }`; resources are instantiated per registration |
| `registerRemote({ address, capabilities, transportId, concurrency? })` | Registers an external Worker; transport must be installed; caller capacity defaults to unlimited, receiver limits still apply |
| `workers()` | Snapshots address, capabilities, available, active and concurrency without exposing SDKs or credentials |
| `handle.setAvailable(false/true)` | Pause/resume routing; accepted invocations continue |
| `handle.unregister()` | Removes directory entry, returning whether it existed; cleanup remains owned by the handle or Runtime |
| `handle.close()` | Unregister, drain accepted calls, dispose once; repeated calls share the promise |
| `runtime.close()` | Reject new top-level work, remove this Runtime's subscriptions, drain accepted graphs/loops/calls/event handlers, then dispose Workers; repeated calls share the promise |

```ts
context.setAvailable(false);
context.setAvailable(true);
context.unregister();
await context.close();
```

Applications own shared EventFabric instances, transports, child processes, HTTP servers and injected database connections. Stop ingress, close Runtime, then release external resources. Worker-owned resources can use `defineWorker({ resources, dispose, ... })`. Do not await Runtime.close from its own handler: that would wait for itself.

## Graph construction and execution

```ts
import { graph } from "@ditto/core";
const prepare = graph<string>("prepare")
  .node("load", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }))
  .node("select", "CONTEXT.SELECT", ["load"], (_input, { load }) => ({ context: load, purpose: "infer" }));
const result = await runtime.run(prepare, "Find relevant information", {
  concurrency: 2,
  workers: { load: "context-a", select: "context-a" },
  signal: AbortSignal.timeout(30_000),
});
console.log(result.select.context);
```

`graph<I>(id?)`, `runtime.graph<I>(id?)` and `ExecutionGraph.create<I>(id)` create immutable graphs. `.node(id, nodeType, dependencies, bind)` returns a new graph; retain the return value. IDs must be unique and dependencies must name earlier nodes. Empty dependencies allow parallel execution. `bind(input, outputs)` sees only declared dependencies and returns the selected Node's typed input. Worker IDs, clients, credentials and endpoints belong to execution options rather than graph definitions.

`runtime.run(plan, input, options?)` returns results keyed by task ID. `workers` maps task IDs to Worker IDs, leaving unbound tasks on automatic routing. Invalid bindings and capability mismatches reject before execution; a pinned unavailable Worker does not silently fall back. Concurrency precedence is call option → YAML `runtime.graphConcurrency` → unlimited.

The scheduler builds an O(V+E) dependency index and ready queue. On an exception it stops starting tasks, drains started branches, and rejects with the first observed error. A business result with `status: "failed"` remains ordinary data: check it in bind and throw or forward deliberately. Output freezing is shallow; large payloads are not copied.

Worker concurrency limits each replica; graph concurrency limits each run. Full replicas cause `NoWorkerAvailableError`; no additional capacity queue is created. For parallel tasks pinned to a single-capacity replica, set graph concurrency to 1, add replicas, or change dependencies. Applications also control admission across concurrent graph runs.

## Loop: repetition and graph selection

```ts
import { loop } from "@ditto/core";
const alternate = graph<string>("alternate")
  .node("load", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }))
  .node("select", "CONTEXT.SELECT", ["load"], (_input, { load }) => ({ context: load, purpose: "infer" }));
const workflow = loop({
  graph: (state: { round: number; text: string }) => state.round % 2 ? alternate : prepare,
  maxIterations: 4,
  bind: state => state.text,
  update: (state, output) => ({ round: state.round + 1, text: String(output.select.context.items[0]?.content ?? "") }),
  done: state => state.round >= 4,
});
const state = await runtime.loop(workflow, { round: 0, text: "hello" }, {
  concurrency: 1,
  workers: { prepare: { load: "context-a" }, alternate: { load: "context-a" } },
});
console.log(state.round); // 4
```

`loop(definition)` freezes a definition; `runtime.loop` also accepts a plain definition. `graph` is a fixed graph or synchronous selector based on state. Each iteration selects → binds → runs → updates → checks done. It runs at least once; done receives updated state and current output. Candidate graphs share an input/output contract; tagged unions can represent different business states.

The positive integer iteration limit comes from the definition, YAML `runtime.loopMaxIterations`, or 32. Reaching the limit without done throws. Execution worker bindings are grouped by graph ID; concurrency and signal cover the whole loop. State stays on the caller; only Node requests cross transports. There is no implicit persistence, retry or checkpointing.

## Worker-specific services and Sandbox

```ts
import { createRuntimeServices, createInteractionWorker } from "@ditto/core";
const services = createRuntimeServices({
  config, sandbox: { tools: ["inspect_text"], read: true },
  // sandboxExecutor: applicationContainerExecutor,
});
const reader = runtime.register(createInteractionWorker({ tools: [inspectTextTool] }), {
  id: "file-reader", services,
});
```

`inspectTextTool` is an application RegisteredTool; see the [complete example](../../examples/runtime/graph-loop.ts). Omit services to share Runtime defaults. Independent services can supply a different workspace (`config.workspace`), permission policy, ProviderRegistry and SandboxExecutor. HTTP providers are constructed against their corresponding Sandbox; reusing a broader provider while replacing only sandbox would not isolate its network access. Custom injected providers/SDKs must honor application policy themselves.

`ctx.invoke` uses the destination Worker's services. Remote hosts supply their own configuration; envelopes cannot override deployment settings. Sandbox is a cooperative capability guard. For arbitrary JS or SDK isolation, deploy the Worker in a separate process/container and inject the appropriate executor; Runtime does not create containers.

## Worker context and cancellation

```ts
import { defineWorker } from "@ditto/core";
const loader = defineWorker({ type: "CONTEXT", nodes: {
  "CONTEXT.LOAD": async (input, ctx) => {
    ctx.signal?.throwIfAborted();
    console.log(ctx.worker.workerId, ctx.execution?.graphId, ctx.execution?.runId, ctx.execution?.nodeId);
    const result = await ctx.invoke("CONTEXT.LOAD", input, { workerId: "context-a" });
    await ctx.emit({ type: "context.loaded", payload: { count: result.items.length } });
    return result;
  },
} });
```

`ctx.resources/config` hold Worker resources/config; `ctx.services` holds its execution environment and `ctx.artifacts` the optional store. `ctx.invoke(node, input, { workerId?, signal? })` invokes public capabilities with inherited execution scope and cancellation. `ctx.run(internalGraph, input)` runs on the current replica, including unexposed internal nodes, without consuming another top-level capacity slot. Await internal calls before the handler returns.

Cancellation is cooperative. Local handlers receive `ctx.signal` and can forward it to SDKs or `ctx.services.sandbox.run(command, ctx.signal)`. Graph/Loop stop subsequent tasks and drain started local work; arbitrary JS is not forcibly interrupted. IPC/HTTP cancellation and timeout stop the caller's wait, not remote execution. Use business idempotency keys for retried side effects.

## Events

```ts
const unsubscribe = runtime.subscribe("context.loaded", event => { console.log(event.payload); });
await runtime.emit({ type: "context.loaded", payload: { count: 2 } });
const failures = await runtime.drainEvents();
for (const failure of failures) console.error(failure.event.type, failure.error);
unsubscribe();
```

Emit acknowledges acceptance rather than consumer completion. Subscribe returns an independently owned removal function. Drain waits for accepted Fabric handlers and consumes failure records; a shared Fabric includes shared consumers. Default `LocalEventFabric` dispatches asynchronously within the process. Middleware adapters implement `EventFabric.emit/subscribe/drain` and are explicitly injected.

## IPC and HTTP adapters

```ts
import { createIpcTransport, serveWorkerIpc } from "@ditto/core";
// Parent: child is a node:child_process.fork result; exchange address at startup.
const ipc = createIpcTransport({ id: "local-ipc", channel: child, timeoutMs: config.timeoutMs });
const app = createDitto({ hostId: "machine-a", transports: [ipc] });
app.registerRemote({ address: childAddress, capabilities: ["CONTEXT.LOAD"], transportId: ipc.id, concurrency: 4 });
await app.invoke("CONTEXT.LOAD", { sources: [] });
await app.close(); ipc.close(); // Application separately shuts down the child.
// Child: register local Workers before mounting the receiver.
const receiver = serveWorkerIpc(workerRuntime, process);
await receiver.close(); // During shutdown, detach and drain accepted replies.
await workerRuntime.close();
```

`IpcChannel` accepts Node ChildProcess or an IPC-enabled process. It requires an existing parent/child channel. Timeout defaults to 30000 ms, valid range 1–2147483647. Invocation IDs correlate responses; timeout, abort, disconnect and close clean up pending callers. Failures return a generic message. IPC is for trusted application channels, without a network token.

```ts
import { createHttpTransport, createWorkerHttpHandler } from "@ditto/core";
const http = createHttpTransport({ id: "remote", url: endpoint, token, timeoutMs: config.timeoutMs });
const app = createDitto({ hostId: "machine-a", transports: [http] });
app.registerRemote({ address: remoteAddress, capabilities: ["CONTEXT.LOAD"], transportId: http.id });
// Server: createServer(createWorkerHttpHandler(workerRuntime, { token })).listen(...)
```

The HTTP endpoint is `/ditto/invoke`; default request/response limit is 1 MiB, configurable with maxBodyBytes. Both ends must use the same token; use HTTPS between production hosts. [placement.ts](../../examples/runtime/placement.ts) includes startup, address exchange, graph execution and cleanup. `receive(envelope)` is the adapter-facing receiver with target/capability validation; business code should use typed invoke/run.

For `InMemoryArtifactStore`, `PayloadCodec` and external stores, see [communication](../worker-communication.md). Existing `runRagFlow/runSkillFlow/runToolCallFlow/runMcpFlow/runReactFlow` remain available; see [Interaction API](interaction.md).

## Cancellation through built-in Workers

For local execution, the Runtime signal reaches INFER model providers, MEMORY database adapters, CONTEXT services, RETRIEVAL pipelines and INTERACTION tools/MCP clients. SDK adapters must forward it to an underlying implementation that supports cancellation. Cancellation does not undo completed side effects. Shutdown drains already accepted Graph/Loop work, including nested ctx.invoke delegation. HTTP and IPC currently cancel the caller's wait without a remote task cancellation protocol.
