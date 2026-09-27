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

[Portable checkpoints, isolated state and token budgets](checkpoints.md): Graph/Loop recovery, BranchStore and provider accounting in `@codesoul-co/ditto@0.1.1`.

[Worker composition, events and Artifacts](composition.md): custom nodes/Workers, resources/dispose, WorkerContext, references and communication adapters.

[Predefined flows](flows.md): complete inputs, outputs and examples for RAG, Skill, Tool, MCP and ReAct.

[Conditions and routing API usage](routing.md): six application routes, joins, file input boundaries, independent tool configuration and package consumption.

[Parallel execution and aggregation API usage](parallel.md): concurrency, automatic planning, dependency joins and retained partial results.

## Start here

1. Define an Agent Graph with semantic nodes, data mappings, and failure policy; keep clients and credentials outside it.
2. Add a Loop when needed: state, update, done, and maxIterations. Use runtime.run for one Graph or runtime.loop for repetition.
3. Supply Worker implementations: model providers, MemoryStore/search, RegisteredTool/McpClient/OutputSink.
4. Register Workers in Runtime; load YAML behavior settings and env connection/credential settings explicitly.
5. Register optional RETRIEVAL only when independent search resources are needed; ordinary native MEMORY search does not need it.

See [Graph + Loop + Worker](examples/graph-loop-worker.ts) and [real command/tool composition](examples/interaction-tools.ts).

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

[Loops and dynamic adjustment API usage](iteration.md): bounded execution, replanning, iterative improvement/retrieval, goal checks and stopping conditions.

[Error and recovery API usage](recovery.md): reason-aware retries, fallback, timeouts, checkpoint/session recovery, approval pauses, compensation and side-effect reconciliation.

[Human intervention APIs and examples](human.md): approval before execution, intermediate confirmation, edited continuations, reviewed publication and human handoff.

[Task lifecycle APIs and examples](lifecycle.md): state tracking, guarded execution, safe stopping, scheduled triggers and event triggers.

[Public API boundaries and unified package acceptance](control-flow.md): capability mapping for 38 examples, strict external consumer types and real task verification.

[Request understanding and interaction through public APIs](understanding.md): goals, constraints, clarification, conversation, choices, and intent handling.

[Planning and task management APIs](planning.md): decomposition, dependency graphs, budget admission, and tool selection with Redis Context and database Memory.

[Information retrieval and search workflows](search-workflows.md): eight public-API examples with real Redis, database Memory, document/FTS/web evidence and source citations.

[Information organization and analysis APIs](analysis-workflows.md): source consolidation, deduplication, conflicts, reference checks, extraction, conversion and comparisons with durable provenance.

[Context workflow APIs](context-workflows.md): load, select, assemble, summarize/compress and update with Redis, database Memory and complete task recovery.

[Memory workflows](memory-workflows.md): recall, policy-based writes, updates and task checkpoints across SQLite, PostgreSQL and Qdrant.

[Tool and system operation APIs](tool-workflows.md): ten workflows with native tool selection, real operations, Redis/database checkpoints and isolated package acceptance.

[Execution result understanding APIs](observation-workflows.md): result reading/parsing, error classification, transactional state updates and evidence-based follow-ups.

[Content processing APIs](content-workflows.md): seven generation/transformation workflows with evidence validation, model review, citations and actual file delivery.

[Document and multimodal APIs](multimodal-workflows.md): PDF/Word, images, charts, audio, video and meeting notes with traceable media evidence and public Worker composition.

[Data and code APIs](data-code-workflows.md): twelve actual data/source workflows with read-only SQL, container execution, charts, tests and traceable reviews.

[Validation and safety APIs](validation-workflows.md): evidence-based evaluation, trusted policy enforcement, pre-inference redaction and recoverable publication.

[Agent capability composition and npm consumption](capability-composition.md): the 12-category, 86-entry public API matrix and unified release gate.

[Complete RAG application](rag-workflows.md): authenticated requests, ingestion, retrieval, Context, answers, per-claim citations and durable recovery.

[Graph / Loop composition](graph-loops.md): Loop owns stage Graphs, branches, repetition, budgets and recovery.

[Web search question answering](web-search-workflows.md)

[Deep research workflows](research-workflows.md): adaptive multi-round research, evidence coverage, budgeted recovery and cited reports.

[Durable ReAct tasks](react-workflows.md): native action/observation cycles, verified business effects, Redis/Memory recovery and browser tasks.

[Durable Plan-and-Execute tasks](plan-execute-workflows.md): complete plans, dependency and budget validation, verified business execution and replanning of remaining work.

[Reflection / Self-Refine](reflection-workflows.md): generation, critique, dual validation, versioned refinement and durable recovery.

[Multiple candidates and selection](candidate-workflows.md): distinct generation angles, individual evaluation, stable ranking, traceable fusion and re-evaluation.

[Tool-chain execution](tool-chain-workflows.md): serial/parallel/conditional dependencies, verified CRM and inbox effects, idempotency and durable recovery.

[Human-in-the-loop application](human-loop-workflows.md): authenticated review, versioned edits, Redis/Memory recovery and exact-version publication.

[Multi-Agent division of work](multi-agent-workflows.md): scoped specialist Agents, parallel/serial dependencies, verified handoffs and durable synthesis.

[Supervisor workflows](supervisor-workflows.md): manager decisions, evidence-driven redelegation, bounded specialist retries and durable review history.

[Agent Handoff workflows](handoff-workflows.md): acknowledged ownership transfer, versioned handoff chains and durable ticket recovery.

[Specialist Agent routing](specialist-routing-workflows.md): main-agent classification, specialist fit checks, scoped task execution and recovery.

[Multi-perspective discussion](debate-workflows.md): independent parallel views, explicit agreement/disagreement and synthesis that preserves dissent.

[Automatic repair](auto-repair-workflows.md): actual failure feedback, bounded changes, re-execution, verified artifacts and durable recovery.

[Long tasks and recovery](long-running-workflows.md): durable batch checkpoints, committed-effect reconciliation, process recovery and verified delivery.
