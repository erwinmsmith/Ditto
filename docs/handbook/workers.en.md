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

Next: [optional RETRIEVAL](retrieval.en.md) or [custom Workers and Nodes](extensions.en.md).
