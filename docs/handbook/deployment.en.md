# Deployment, resources and lifecycle

Validate the complete application in one process before splitting Workers for capacity or isolation. Graphs retain semantic nodes and dependencies; the environment configures addresses, replicas and credentials.

## 1. Single-process baseline

| Resource | Create when | Closed by |
| --- | --- | --- |
| Redis / SQL / vector client | Application startup or trusted session resource management | Application |
| Replica-owned resources | definition.resources() | definition.dispose |
| MCP Client / Transport | Application startup and connection | Application after Runtime drains |
| Runtime | After resources are ready | Application |
| Request context | Each request with a trusted scope | TTL / task cleanup policy |

Do not create a connection pool for every Node or close shared SDKs after each request. On shutdown, stop new tasks, cancel or drain in-flight work, persist necessary state and release resources.

## 2. Concurrency has several layers

Graph concurrency limits executing ready nodes in that Graph. Worker concurrency limits entry execution for a replica. Business-object serialization and database transactions need separate handling. Sessions may run concurrently, but writes within one session need an explicit conflict policy.

No available Worker produces an error; Runtime is not an unlimited persistent queue. Add an application queue with capacity, timeout and redelivery rules when needed.

## 3. IPC and HTTP

Runtime supports local, IPC and HTTP communication. Adapters carry node type, target address, payload and execution scope. Receivers use the same contracts. See [Runtime deployment](../worker-api/runtime.md) and the executable [placement example](../worker-api/examples/runtime/placement.ts).

HTTP endpoints need authentication, authorization, TLS and network restrictions. Do not expose unauthenticated receive endpoints publicly. Localhost, working directories and in-memory objects are not shared across machines. Cancellation depends on transport and destination SDK support.

## 4. Events and large objects

`emit` means an event was accepted, not consumed. LocalEventFabric is in-process broadcast, not a distributed durable queue. Implement EventFabric with persistence/redelivery and business idempotency if required.

ArtifactStore represents large payloads by reference. Cross-process participants need access to the same object storage and agreed permissions, expiration and cleanup. Default InMemoryArtifactStore is process-local and does not automatically become a Context ReferenceResolver.

See [composition, events and artifacts](../worker-api/composition.md) for interfaces and examples.

## 5. Sandbox and containers

Sandbox checks tool names, MCP servers, skills, network origins and file operations. It is not a container for arbitrary untrusted JavaScript. Third-party SDKs and handlers must enforce cooperative policies. Use constrained containers, low-privilege users, resource caps and separate workspaces for code execution.

Keep credentials out of Graph inputs. Use stable error codes, with detailed diagnostics in controlled logs. A trusted controller selects tenant credentials, directories, Memory namespaces and index filters.

## 6. Monitoring and upgrades

Correlate taskId, turn, graphId, nodeId and invocationId. Record duration, status, budget usage and tool receipts; redact sensitive input first. Do not log entire model outputs, Context or Memory by default.

Maintain contract compatibility when upgrading Workers. Version checkpoint schemas, use recoverable database migrations and validate new indexes before switching. Represent unavailable dependencies, uncertain outcomes and human waiting explicitly rather than returning ambiguous success.

## 7. Package publication versus application deployment

Publishing Ditto installs framework code and declarations, not Redis, databases, models or tool services. Pin application dependencies, install SDKs, inject configuration and validate the deployment environment before enabling business entry points.

[Long-running tasks](../../examples/patterns/long-running/README.md) · [Configuration](../worker-api/configuration.md) · [Recovery](reliability.en.md)
