# Capability and call-chain index

**English** · [简体中文](node-coverage.zh-CN.md) · [Complete API](worker-api/README.md)

Core has 21 routable leaves; optional RETRIEVAL adds SEARCH. This table describes current behavior and how to call it. Applications configure model, database, MCP and delivery services; a declared Node type does not establish those connections.

## Implemented nodes

| Node | Execution and call reference |
| --- | --- |
| `CONTEXT.LOAD` | Build Context from messages/items/references or read a cached scope; explicitly enabled reference resolution. [API](worker-api/context.md) |
| `CONTEXT.SELECT` | Return ContextSelection by purpose, query, budget and strategy; do not persist the projection. [API](worker-api/context.md) |
| `CONTEXT.UPDATE` | Add/remove/replace items and merge ContextIngress into the working set. [API](worker-api/context.md) |
| `CONTEXT.COMPRESS` | Default policy/budget pruning with protected items/groups; no model-generated summary by default. [API](worker-api/context.md) |
| `INFER.REASONING.SAMPLE` | One model call returning message, actionRequests, usage and related fields; no action execution. [API](worker-api/infer.md) |
| `INFER.REASONING.TRAJECTORY` | CoT, Long CoT, ToT, GoT, Self-consistency or an injected strategy; bounded public result/trajectory organization. [API](worker-api/infer.md) |
| `INFER.REASONING.REFLECT` | critique / verify / revise an existing candidate. [API](worker-api/infer.md) |
| `INFER.REASONING.DELIBERATE` | One model call for select / merge / consensus / debate, returning validated assessments/results. [API](worker-api/infer.md) |
| `INFER.CACHE.LOOKUP` | Query an injected computation cache. [API](worker-api/infer.md) |
| `INFER.CACHE.WRITE` | Explicitly cache computation results with backend-supported TTL/options. [API](worker-api/infer.md) |
| `INFER.CACHE.INVALIDATE` | Invalidate by key/tag/namespace. [API](worker-api/infer.md) |
| `MEMORY.GET` | Read by id/key through MemoryStore. [API](worker-api/memory.md) |
| `MEMORY.QUERY` | Database plugin handles filter/orderBy/cursor/limit. [API](worker-api/memory.md) |
| `MEMORY.SEARCH` | Native database search, a directly reused Provider, or explicit RETRIEVAL delegation. [API](worker-api/memory.md) |
| `MEMORY.WRITE` | Create durable records; plugin allocates IDs and returns complete records. [API](worker-api/memory.md) |
| `MEMORY.UPDATE` | Modify existing records by ID with documented field semantics. [API](worker-api/memory.md) |
| `MEMORY.DELETE` | Delete by ID and return the IDs actually removed. [API](worker-api/memory.md) |
| `INTERACTION.ACT.TOOL` | Execute registered tools with name, input and Sandbox checks. [API](worker-api/interaction.md) |
| `INTERACTION.ACT.MCP` | Discover/invoke through connected clients; the operations return distinct shapes. [API](worker-api/interaction.md) |
| `INTERACTION.OBSERVE` | Normalize ExternalResult into Observation with a tool Message. [API](worker-api/interaction.md) |
| `INTERACTION.OUTPUT` | Submit through OutputSink and return an accepted/rejected/unknown receipt. [API](worker-api/interaction.md) |
| `RETRIEVAL.SEARCH` (optional) | Execute a target/strategy Provider with optional embedding, fusion and reranking. [API](worker-api/retrieval.md) |

CONTEXT caching stores working sets; INFER caching stores computation results; MEMORY accesses durable databases. Applications and their storage plugins manage these distinct lifecycles.

## Common call chains

| Need | Composition | Input/output mapping |
| --- | --- | --- |
| First run | LOAD → SELECT | SELECT returns context/selectedItemIds/purpose; run the [quickstart](../examples/quickstart.ts) |
| Document question answering | LOAD → SELECT(rag) → SAMPLE → OUTPUT | Inject ragStrategy, map selected items to messages and inspect SAMPLE NodeResult |
| Durable recall | MEMORY.SEARCH → UPDATE → SELECT → SAMPLE | Check status, map complete MemoryItems to ContextIngress; search results are not model messages |
| Multiple tool steps | ReAct: SAMPLE → TOOL/MCP invoke → OBSERVE → next SAMPLE | Supply model-visible schemas and register matching tools on the execution Worker; [flow API](worker-api/flows.md) |
| Read and store database results | MEMORY.GET/QUERY → application mapping → MEMORY.WRITE/UPDATE | SDKs perform database operations; cross-node calls are not an automatic transaction; applications/plugins own idempotency and transactions |
| Compare or revise candidates | SAMPLE/TRAJECTORY → REFLECT or DELIBERATE | Supply explicit public results; obtain independent candidates through repeated calls or trajectory strategies |
| Load Skill instructions | Application resolution/authorization → runSkillFlow(LOAD → optional UPDATE) | Sources are already resolved; the flow does not scan files, install plugins or execute scripts |
| Discover and use a tool | MCP discover → application capability selection → MCP invoke → OBSERVE | Discovery returns descriptions, not ExternalResult; do not pass discovery directly to OBSERVE |
| Context budget management | SELECT / COMPRESS | Default selection/pruning; model summaries require explicit INFER calls and application-directed UPDATE |
| Independent retrieval resources | MEMORY/CONTEXT adapter → RETRIEVAL.SEARCH | The same Provider can run within the original Worker, then move behind an independent retrieval Worker when needed |

SQL and Milvus own storage and supported retrieval; Ditto does not duplicate databases. Embedding may be database-native or supplied by an external cloud/local Provider. Native database search does not require RETRIEVAL. [Database examples](worker-api/examples/integrations/README.md) · [Retrieval Providers](worker-api/retrieval-providers.md).

## Execution boundaries

- Graph defines nodes, dependencies and bindings. Exceptions stop subsequent work; applications explicitly handle structured failed outputs.
- Loop owns state, graph selection, repetition and termination; it does not persist state or reset sessions automatically.
- Same-process calls are direct, same-host processes use IPC, and separate hosts use HTTP. Worker settings and SDKs remain on the execution host. [Deployment API](worker-api/runtime.md)
- Node descriptors, type entry points and index exports do not execute business work. Factories configure implementations; register creates routable replicas. [Composition API](worker-api/composition.md)
