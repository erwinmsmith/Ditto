# Worker usage API

**English** · [简体中文](README.zh-CN.md) · [Documentation map](../README.md)

These references follow current public exports and cover factories, SDK methods, every Worker node, providers/storage ports, registries, configuration, and lifecycle. Operations include examples; complete TypeScript examples in [examples](examples/README.md) participate in `npm run typecheck`. An interface does not imply an automatic database driver or plugin loader.

| Worker | Reference | Operations and examples |
| --- | --- | --- |
| CONTEXT | [中文 API](context.zh-CN.md) · [English](context.md) | LOAD / SELECT / UPDATE / COMPRESS; Redis / TTL-LRU / stateStore / RAG / ReferenceResolver |
| INFER | [API](infer.md) · [中文](infer.zh-CN.md) | SAMPLE / TRAJECTORY / REFLECT / DELIBERATE / CACHE LOOKUP, WRITE, INVALIDATE; SDK + stream |
| MEMORY | [API](memory.md) · [中文](memory.zh-CN.md) | GET / QUERY / SEARCH / WRITE / UPDATE / DELETE; store / search |
| INTERACTION | [API](interaction.md) · [中文](interaction.zh-CN.md) | ACT.TOOL / ACT.MCP / OBSERVE / OUTPUT; ToolRegistry / McpRegistry / OutputSink |
| RETRIEVAL (optional) | [API](retrieval.md) · [中文](retrieval.zh-CN.md) | SEARCH; SDK / target / strategy / deployment |

[Runtime / Graph / Loop API](runtime.md): node dependencies, Worker placement, independent sandboxes, local IPC and cross-host HTTP.

[Worker composition, events and Artifacts](composition.md): custom nodes/Workers, resources/dispose, WorkerContext, references and communication adapters.

[Predefined flows](flows.md): complete inputs, outputs and examples for RAG, Skill, Tool, MCP and ReAct.

## Start here

1. Define an Agent Graph with semantic nodes, data mappings, and failure policy; keep clients and credentials outside it.
2. Add a Loop when needed: state, update, done, and maxIterations. Use runtime.run for one Graph or runtime.loop for repetition.
3. Supply Worker implementations: model providers, MemoryStore/search, RegisteredTool/McpClient/OutputSink.
4. Register Workers in Runtime; load YAML behavior settings and env connection/credential settings explicitly.
5. Register optional RETRIEVAL only when independent search resources are needed; ordinary native MEMORY search does not need it.

See [Graph + Loop + Worker](../../examples/graph-loop-worker.ts) and [real command/tool composition](../../examples/interaction-tools.ts).

## Results and errors: distinct contracts

| Call layer | Returns | Failure behavior |
| --- | --- | --- |
| INFER / MEMORY / RETRIEVAL SDK or Worker | `NodeResult<T>` | Check status before consuming output; construction/routing/transport can still throw |
| CONTEXT | `Context` / `ContextSelection` | Rejects with ContextError or service errors |
| INTERACTION | `ExternalResult` / `Observation` / MCP union / `OutputReceipt` | Check the appropriate status; validation/permission/infrastructure errors throw |
| Underlying store / Provider / Sink | Their raw Output | Workers wrap or validate it; do not add another NodeResult |

INFER trajectories also expose output.status: outer success does not imply completed. Cancellation/timeout does not prove rollback; applications/adapters own idempotency and retries for databases, commands, MCP, and delivery.

## Adapters and configuration

- [Model providers: registration/removal, HTTP, vendor protocols, invoke/stream](providers.md)
- [Retrieval providers: embedding, vector/text, RRF, reranking, SQL/Milvus, and Memory bridges](retrieval-providers.md)
- [Shared configuration: root ditto.yaml / .env fields, groups, and precedence](configuration.md)

INTERACTION tools, MCP clients, and output functions are injected through code. YAML supports `workers.interaction.commands/webSearch` behavior defaults; plugin instances are still explicitly injected and are never autoloaded. Applications own database/model SDK lifecycle.

## Examples

| Example file | Coverage |
| --- | --- |
| [context.ts](examples/context.ts) | LOAD / SELECT / UPDATE / COMPRESS; scope / Redis / Graph |
| [memory.ts](examples/memory.ts) | Both factories, six operations, execute, pagination, plugins, errors, Graph, descriptors |
| [infer.ts](examples/infer.ts) | Both factories, seven leaves, five strategies, three reflection/four deliberation modes, four streams, cache and model providers |
| [interaction.ts](examples/interaction.ts) | Factories, registration/removal, four nodes, MCP, observations, receipts, handlers, Graph/Loop |
| [retrieval.ts](examples/retrieval.ts) | Factories, SEARCH, registry, embedding, fusion/reranking, database adapters, Memory bridges |

[Sandbox API](runtime.md#sandbox-api-and-local-execution): permissions, workspace I/O, replaceable executors and real local commands.
