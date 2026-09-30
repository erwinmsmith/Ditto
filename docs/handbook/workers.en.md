# Worker internals and application data flow

A Worker is an implementation and resource boundary. Applications invoke Node types and Runtime selects available replicas. A Worker type is not an Agent role such as “finance Agent”: a role usually combines Workers, and several roles may share Worker types.

## 1. Data flow between Workers

```text
MEMORY.GET / SEARCH → validate and map ─┐
User messages / Skills / documents ────┴→ CONTEXT.LOAD / UPDATE
                                                ↓ SELECT
                                          INFER.REASONING.*
                                         ↙                 ↘
                                 Action request          Final content
                                      ↓                       ↓
                             INTERACTION.ACT.*        Validate → OUTPUT
                                      ↓                       ↓
                             INTERACTION.OBSERVE        MEMORY.WRITE
                                      ↓
                               CONTEXT.UPDATE → Loop
```

Mapping is explicit: Memory content is unknown, ContextItem metadata holds roles, Infer messages represent model content, and Interaction reports action state. Do not join similarly named types without conversion.

## 2. CONTEXT: prepare the working set

| Node | Internal responsibility | Extension points |
| --- | --- | --- |
| LOAD | Normalize messages/references/items and generate/check IDs | ReferenceResolver, stateStore |
| SELECT | Select by purpose, strategy, item count and token budget | selector, ragStrategy, tokenEstimator |
| UPDATE | Remove/add items and merge cross-Worker ingress | Cache CAS, operationQueue |
| COMPRESS | Trim by protection groups and budget | compressor, tokenEstimator |

Default compression does not ask a model for a semantic summary. Use explicit INFER → validation → UPDATE → COMPRESS for summarization, keeping provenance, budgets and failures observable. Redis mode uses scopes and versions; explicit mode computes from the supplied snapshot.

Read data formats, cache mode, selection/compression plugins and errors in the [CONTEXT API](../worker-api/context.md), then explore [five context tasks](../../examples/capabilities/context/README.md).

## 3. INFER: model operations and reasoning strategies

INFER exposes four reasoning leaves and three CACHE leaves. ProviderRegistry resolves named adapters, inference execution handles budgets/cancellation, and strategies organize the reasoning task. Tools and business databases are outside its default execution path.

| Operation | Key distinction |
| --- | --- |
| SAMPLE | Produces a response or action request; does not execute it |
| TRAJECTORY | Multi-step reasoning with outer and inner status |
| REFLECT | Reviews or revises an existing result |
| DELIBERATE | Evaluates, selects or combines candidates |
| CACHE | Explicit inference cache independent of Context/Memory |

See [INFER](../worker-api/infer.md) for strategies, budgets and streaming, and [Providers](../worker-api/providers.md) for custom model protocols.

## 4. MEMORY: persistence and search

MEMORY validates inputs, applies query/pagination limits, calls Store/Search providers, validates outputs and wraps NodeResult. It does not bundle a business database driver or schema. Adapters implement transactions, atomicity, idempotency and index consistency.

GET/QUERY and SEARCH serve different purposes. UPDATE modifies by id; DELETE accurately reports removed IDs. Stable errors must not expose connection strings containing passwords to models.

Start with [databases and algorithms](memory.en.md), then consult the [six MEMORY nodes](../worker-api/memory.md).

## 5. INTERACTION: actions, observations and delivery

| Node | Internal component | Application resource |
| --- | --- | --- |
| ACT.TOOL | ToolRegistry | RegisteredTool and business SDK |
| ACT.MCP | McpRegistry | Connected neutral McpClient |
| OBSERVE | Result normalization | No automatic retries or Context updates |
| OUTPUT | Receipt validation | Application OutputSink |

Action failure is business information; infrastructure failures may also throw. Handle both paths. Descriptive approval fields do not enforce approval, and accepted alone does not prove delivery completion. See [INTERACTION](../worker-api/interaction.md).

## 6. Shared lifecycle

Create/connect shared SDKs → construct definitions → register with Runtime → handle Graph/Loop requests → stop accepting new tasks → drain in-flight requests → Runtime.close → close application-owned clients.

A `resources` factory creates replica-specific resources; `dispose` releases them. Passing one client to several definitions shares it. Do not close a shared client when the first replica stops while others still need it.

## 7. Understand Nodes and parameters by function

Choose the Node's responsibility before tuning its parameters. The same `INFER.REASONING.SAMPLE` can answer a question, produce a plan or classify a request; messages and model configuration specify the task. The Node type establishes the execution contract; parameters select this call's inputs, algorithm or limits.

| Parameter layer | What it controls | Effect on the Worker |
| --- | --- | --- |
| Node input | Content, selection conditions, generation settings, strategy and result count for one call | Changes that invocation without modifying Worker-wide configuration |
| Worker construction | Providers, stores, tools, defaults and replica concurrency | Determines available capabilities, resources and simultaneous entry calls |
| Runtime / Graph / Loop | Dependencies, Graph concurrency, Worker bindings, cancellation and Graph execution limits | Controls scheduling; does not automatically add model candidates or database pool capacity |
| External adapter | Supported model parameters, database indexes, tool validation and backend deadlines | Determines actual resource behavior; passing Ditto validation does not prove every remote parameter is supported |

These limits act together. Graph concurrency 4 and INFER replica concurrency 2 do not imply eight allowed simultaneous model calls. A long TRAJECTORY makes several model requests inside one Worker invocation; more rounds keep that slot occupied longer. Reducing Context limits model input, whereas INFER `maxTokens` limits an individual generation's output budget.

### Follow the goal to its parameter guide

| Goal | Read |
| --- | --- |
| Keep enough evidence for this step while limiting input | [CONTEXT: functional selection and parameter effects](../worker-api/context.md#functional-selection-and-parameter-effects) |
| Balance stability, diversity, reasoning depth and cost | [INFER: functional selection and parameter effects](../worker-api/infer.md#functional-selection-and-parameter-effects) |
| Restore tasks exactly, search durable memory or modify records | [MEMORY: functional selection and parameter effects](../worker-api/memory.md#functional-selection-and-parameter-effects) |
| Execute tools, interpret action results and verify delivery | [INTERACTION: functional selection and parameter effects](../worker-api/interaction.md#functional-selection-and-parameter-effects) |
| Tune retrieval coverage, candidate pools, fusion and reranking | [RETRIEVAL: functional selection and parameter effects](../worker-api/retrieval.md#functional-selection-and-parameter-effects) |

Evaluate parameters against task outcomes. For models, record format validation, factual evidence, truncation rate, call count, token usage and latency. For retrieval, check whether relevant evidence reaches the candidate pool and final Context. For writes, check persisted records and actual receipts. Change one primary variable at a time using the same tasks and evidence. Temperature is not confidence, relevance scores are not correctness probabilities, and a successful return does not automatically establish business completion.

Next: [optional RETRIEVAL](retrieval.en.md) or [custom Workers and Nodes](extensions.en.md).
