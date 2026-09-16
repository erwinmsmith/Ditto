# Worker Communication and Deployment

**English** · [简体中文](worker-communication.zh-CN.md)

> Runtime `invoke` / `emit` are internal communication semantics, not Interaction Nodes. `INTERACTION.RUN` has been removed. Application Graphs and Loops invoke exposed leaf capabilities; the Loop and its state remain with the caller.

## Location and Invocation

| Location | Current implementation | Data and execution |
| --- | --- | --- |
| Same process | Direct Worker executor calls | Preserves object identity without serialization |
| Different processes on one host | HTTP loopback or a custom InvokeTransport | Serializes public Node calls; preferred over cross-host routing |
| Different servers | HTTP(S) transport and receiving handler | Authentication, Envelope validation, response correlation, size limits, and timeouts |

`ctx.invoke` and top-level `runtime.invoke` share capability routing. The HTTP adapter uses the standard library and does not depend on frameworks such as Express. worker_threads / MessagePort / NATS require a custom `InvokeTransport`. HTTP is a working network adapter, tested through real loopback sockets.

## HTTP Example

The following snippets are startup code for two separate processes. Exchange registered addresses through deployment configuration. Public Node implementations and internal Graphs must already be deployed on the execution host.

Server:

```ts
import { createServer } from "node:http";
import { createDitto, defineWorker, loadRuntimeConfig, createWorkerHttpHandler } from "@ditto/core";

const token = process.env.DITTO_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_WORKER_TOKEN");
const runtime = createDitto({ hostId: "server-a", processId: "agent-service", config: loadRuntimeConfig() });
const worker = runtime.register(defineWorker({
  type: "memory", concurrency: 8, expose: ["MEMORY.RETRIEVE"],
  nodes: {
    "MEMORY.RETRIEVE": async ({ selector }) =>
      selector.ids?.map((id) => ({ id, message: { role: "assistant", content: `memory:${id}` } })) ?? [],
  },
}), "memory-a");
const server = createServer(createWorkerHttpHandler(runtime, { token }));
server.listen(8080, "127.0.0.1");
console.log(worker.address); // Pass to the caller through deployment configuration; contains no key
```

Caller:

```ts
import { createDitto, createHttpTransport } from "@ditto/core";

const token = process.env.DITTO_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_WORKER_TOKEN");
const transport = createHttpTransport({
  id: "server-a-http", url: "http://127.0.0.1:8080/ditto/invoke", token, timeoutMs: 30_000,
});
const runtime = createDitto({ hostId: "client", transports: [transport] });
runtime.registerRemote({
  address: { workerId: "memory-a", workerType: "memory", hostId: "server-a", processId: "agent-service" },
  capabilities: ["MEMORY.RETRIEVE"], transportId: transport.id,
});
try {
  console.log(await runtime.invoke("MEMORY.RETRIEVE", { selector: { ids: ["example"] } }));
} finally { await runtime.close(); }
```

For cross-server deployments, use a controlled HTTPS endpoint with TLS termination or a Node HTTPS Server. The plaintext loopback example is for local development. Install one transport per server and register each server's addresses. Workers exposing the same capability participate in routing without changing Graphs.

The same registration works with `runtime.run()` and `runtime.loop()`. A Loop may select a different DAG each round; only that DAG's Node calls cross HTTP. Deploy and expose every capability the selected Graphs need. Each execution host owns its resources, Provider configuration, and permissions. Remote registration does not upload Graph functions or Loop state machines.

## Protocol and Responsibilities

Requests contain an invocation ID, source/target Worker addresses, Node name, payload, and optional Graph/run/task identifiers. Response IDs must match. HTTP uses `x-ditto-protocol: 1`, a Bearer token, and a default body limit of 1 MiB. Redirects are rejected to avoid forwarding authentication headers elsewhere.

The receiving handler validates the Envelope shape. The Runtime then checks target host/process/type/id, public capability, and availability. Nodes and tool executors remain responsible for business-input validation; TypeScript declarations do not validate network inputs at runtime. HTTP errors do not expose handler stacks or Provider response bodies.

The token is a service-level credential that authorizes all public capabilities in that service's Runtime; it is not a tenant or per-Node ACL. External requests should pass through the application's authentication/tenant gateway. Use `expose` to limit public entry points. The execution host uses its own Provider keys, model, and Sandbox settings; callers cannot override those through an Envelope. Business inputs may still contain sensitive content, so applications must manage logging and storage accordingly.

Calls are not retried automatically. A timeout or disconnect leaves the result unknown: the remote side may still be executing or may already have performed effects. An HTTP client timeout ends only the wait; it does not provide remote cancellation, deduplication, transactions, or exactly-once execution. Retrying effects requires application-level idempotency keys and persistent result records. Remote overload currently returns a generic failure; the caller has no automatic failover or health probing.

During shutdown, first stop accepting new HTTP requests and await application-level work, then close the Runtime and Server. Owners close external MCP and Provider connections. `registerRemote` only adds a local directory entry; it does not start a server or copy Worker code to another machine.

## invoke, emit, and Artifacts

`invoke` is request/response; `emit` submits an event to EventFabric. The default LocalEventFabric performs asynchronous in-process fan-out. A successful emit means only that the event was accepted. `drainEvents()` returns consumer failures. Runtime.close does not automatically close a shared EventFabric. Cross-server Pub/Sub requires an external EventFabric independent of the request transport; HTTP invoke does not forward events implicitly.

Transport payloads use either `inline` or `reference`. With an ArtifactStore, JSON data exceeding inlineLimitBytes (64 KiB by default) can be stored and passed by reference; responses use the same mechanism. Direct in-process calls do not scan payload sizes.

InMemoryArtifactStore is for single-process experiments. Cross-host references require a Store/Resolver accessible to both hosts; its implementation owns access control, TTL, and cleanup. Automatically generated references are not collected automatically. Without a shared Store, keep data inline and choose appropriate body limits. The network boundary supports JSON-encodable inputs and outputs, not arbitrary classes, functions, undefined, or binary streams.
