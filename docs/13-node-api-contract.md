# Ditto Node Taxonomy and API Contract

> Executable Worker APIs: [INFER](worker-api/infer.md) · [MEMORY](worker-api/memory.md).

**English** | [简体中文](13-node-api-contract.zh-CN.md)

> Status: final Node taxonomy; API Contract `2.0-rc.1`; INFER and MEMORY have executable Workers.

This document and the linked INFER/MEMORY APIs define the Node tree, semantic boundaries, common public types, and Node input/output contracts. A Node is a composable, independently executable semantic operation. A Worker is the implementation, resource, deployment, and scaling boundary. Graphs compose Nodes; Runtime schedules, routes, communicates, and executes them.

## Runtime predefined flows

Ditto exposes four directly callable Runtime functions from `src/runtime/graph.ts`. They compose existing Nodes and update the current Context; they are not Nodes and do not appear in `NodeContractMap`.

| Function | Standard flow |
| --- | --- |
| `runRagFlow()` | `CONTEXT.RAG.RETRIEVE → CONTEXT.RAG.RANK → CONTEXT.UPDATE`, or `MEMORY.SEARCH → mapMemory → CONTEXT.UPDATE` according to `scope` |
| `runSkillFlow()` | `CONTEXT.SKILL` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP → CONTEXT.UPDATE` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL → CONTEXT.UPDATE` |

Flows return `{ output, context }`. Memory RAG requires `mapMemory` to map arbitrary content into Context and checks NodeResult before updating Context. Skill flow receives an already-resolved `skill` and invokes CONTEXT.SKILL. See [MEMORY API](worker-api/memory.md).

## 1. Final Node tree

```text
INFER
├── REASONING/                  // folder, not a Node
│   ├── TRAJECTORY
│   │   └── CoT / ToT / GoT / ...  // strategies, not Nodes
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
├── CACHE/
│   ├── LOOKUP
│   ├── WRITE
│   └── INVALIDATE
└── PROVIDERS/                  // implementation folder, not a Node

CONTEXT
├── LOAD
├── SELECT
├── UPDATE
├── COMPRESS
├── RAG/
│   ├── EMBED
│   ├── RETRIEVE
│   └── RANK
└── SKILL

MEMORY
├── GET
├── QUERY
├── SEARCH
├── WRITE
├── UPDATE
└── DELETE

INTERACTION
├── ACT/
│   ├── TOOL/                   // source folder; ACT.TOOL remains the semantic Node
│   │   ├── Linux Commands/     // tool folder, not a Node
│   │   │   ├── grep            // registered tool name
│   │   │   ├── ls
│   │   │   ├── cat
│   │   │   ├── find
│   │   │   └── ...
│   │   └── other registered tools
│   └── MCP
├── OBSERVE
└── OUTPUT
```

There are 25 Core routable leaf contracts. INFER.REASONING, INFER.CACHE, INFER.PROVIDERS, RAG branches and INTERACTION.ACT are namespaces; CACHE executes through LOOKUP, WRITE and INVALIDATE. Tool names and reasoning strategies are not Nodes.

## 2. Semantic boundaries

- **INFER** owns model computation. `REASONING` organizes explicit reasoning; it is not hidden model thought. `TRAJECTORY` accepts CoT/ToT/GoT through `strategy`; `REFLECT` revisits a result; `DELIBERATE` compares/combines candidates; `SAMPLE` generates one candidate. There is no separate Generate Node. Providers are implementation adapters, not Nodes. `CACHE` reuses computation results and is not Memory.
- **CONTEXT** owns the working set of the current invocation or turn. `LOAD`, `SELECT`, `UPDATE`, and `COMPRESS` alter that working set. Reset/session lifecycle belongs to Runtime. Context-to-model assembly is an internal `ModelInput` boundary, not a Node.
- **CONTEXT.RAG** retrieves current-task knowledge from documents, repositories, web sources, knowledge bases, or temporary corpora. Its results are not durable by default.
- **MEMORY** exposes GET / QUERY / SEARCH / WRITE / UPDATE / DELETE through injected MemoryStore / MemorySearchProvider ports; external plugins own databases.
- **RAG** is a Runtime/application Graph. Long-term retrieval uses SEARCH without prescribing its internal pipeline; CONTEXT.RAG.EMBED prepares current-corpus indexes.
- **SKILL** is resolved by the application and activated by CONTEXT.SKILL; MEMORY does not manage Skills.
- **INTERACTION** owns semantic interaction with the outside world. `ACT.TOOL` calls registered native tools; `ACT.MCP` discovers or invokes MCP capabilities; `OBSERVE` standardizes external results; `OUTPUT` submits the final result.

Task and user input enter through the application/Runtime boundary, not through a dedicated communication Node. A live external messaging system may be invoked through a registered Tool or MCP capability. Worker-to-Worker `invoke` and `emit` remain Runtime communication primitives. Location and transport never appear in Node Contracts.

## 3. Fixed common public types

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface Reference { uri: string; mediaType?: string; digest?: string; }
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message { role: MessageRole; content: MessageContent; name?: string; }

export interface ContextItem { id: string; content: MessageContent; source?: Reference; metadata?: JsonObject; }
export interface Context { items: readonly ContextItem[]; }
export type ContextSource = Message | Reference | ContextItem;
export type ContextIngressSource =
  | "CONTEXT.SKILL" | "CONTEXT.RAG.RANK" | "MEMORY.SEARCH"
  | "INTERACTION.ACT.TOOL" | "INTERACTION.ACT.MCP";
export interface ContextIngress {
  id: string; sourceNode: ContextIngressSource; content: MessageContent;
  reference?: Reference; metadata?: JsonObject;
}

export interface MemoryDraft { key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemorySearchResult { memory: MemoryItem; score?: number; metadata?: Record<string, unknown>; }

export interface ToolCall { id?: string; name: string; arguments: JsonObject; }
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonObject; }
export interface KnowledgeItem { id: string; content: MessageContent; source?: Reference; metadata?: JsonObject; }
export interface EmbeddingRecord { itemId: string; vector: readonly number[]; }
export interface RagCandidate { item: KnowledgeItem; score?: number; }
export interface Skill {
  name: string; version?: string; description?: string;
  instructions: MessageContent; metadata?: JsonObject;
}

export interface ExternalResult {
  source: string; content: MessageContent; reference?: Reference; metadata?: JsonObject;
}
export interface Observation { source: string; message: Message; }
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability { server: string; name: string; description?: string; inputSchema?: JsonObject; }
```

## 4. Fixed Node inputs and outputs

```ts
import type { NodeResult } from "@ditto/core/contracts";
import type {
  TrajectoryInput, TrajectoryOutput, ReflectInput, ReflectOutput,
  DeliberateInput, DeliberateOutput, SampleInput, SampleOutput,
  CacheLookupInput, CacheLookupOutput, CacheWriteInput, CacheWriteOutput,
  CacheInvalidateInput, CacheInvalidateOutput,
} from "@ditto/core/worker/infer";

export interface ContextLoadInput { sources: readonly ContextSource[]; }
export type ContextLoadOutput = Context;
export interface ContextSelectInput { context: Context; query: Message; limit?: number; }
export type ContextSelectOutput = Context;
export interface ContextUpdateInput {
  context: Context; add?: readonly ContextItem[];
  ingress?: readonly ContextIngress[]; removeIds?: readonly string[];
}
export type ContextUpdateOutput = Context;
export interface ContextCompressInput { context: Context; maxTokens?: number; maxItems?: number; }
export type ContextCompressOutput = Context;
export interface ContextRagEmbedInput { items: readonly KnowledgeItem[]; }
export type ContextRagEmbedOutput = readonly EmbeddingRecord[];
export interface ContextRagRetrieveInput {
  query: MessageContent; corpus: Reference | readonly KnowledgeItem[];
  limit?: number; strategy?: string;
}
export type ContextRagRetrieveOutput = readonly RagCandidate[];
export interface ContextRagRankInput {
  query: MessageContent; candidates: readonly RagCandidate[]; limit?: number; strategy?: string;
}
export type ContextRagRankOutput = readonly RagCandidate[];
export interface ContextSkillInput { context: Context; skill: Skill; }
export type ContextSkillOutput = Context;

export interface MemoryGetInput { ids?: readonly string[]; keys?: readonly string[]; }
export type MemoryGetOutput = readonly MemoryItem[];
export interface MemoryQueryInput {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
}
export interface MemoryQueryOutput { items: readonly MemoryItem[]; nextCursor?: string; }
export interface MemorySearchInput { query: unknown; strategy?: string; filter?: Record<string, unknown>; limit?: number; options?: Record<string, unknown>; }
export type MemorySearchOutput = readonly MemorySearchResult[];
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
export interface MemoryUpdateEntry { id: string; content?: unknown; metadata?: Record<string, unknown>; }
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
export interface MemoryDeleteInput { ids: readonly string[]; }
export interface MemoryDeleteOutput { deleted: readonly string[]; }

export interface InteractionToolInput { call: ToolCall; }
export type InteractionToolOutput = ExternalResult;
export type InteractionMcpInput =
  | { operation: "discover"; server?: string }
  | { operation: "invoke"; server: string; call: ToolCall };
export type InteractionMcpOutput =
  | { operation: "discover"; capabilities: readonly McpCapability[] }
  | { operation: "invoke"; result: ExternalResult };
export interface InteractionObserveInput { result: ExternalResult; }
export type InteractionObserveOutput = Observation;
export interface InteractionOutputInput { message: Message; artifacts?: readonly Artifact[]; }
export type InteractionOutputOutput = OutputReceipt;
```

```ts
export interface NodeContract<Input, Output> { readonly input: Input; readonly output: Output; }
export interface NodeContractMap {
  "INFER.REASONING.TRAJECTORY": NodeContract<TrajectoryInput, NodeResult<TrajectoryOutput>>;
  "INFER.REASONING.REFLECT": NodeContract<ReflectInput, NodeResult<ReflectOutput>>;
  "INFER.REASONING.DELIBERATE": NodeContract<DeliberateInput, NodeResult<DeliberateOutput>>;
  "INFER.REASONING.SAMPLE": NodeContract<SampleInput, NodeResult<SampleOutput>>;
  "INFER.CACHE.LOOKUP": NodeContract<CacheLookupInput, NodeResult<CacheLookupOutput>>;
  "INFER.CACHE.WRITE": NodeContract<CacheWriteInput, NodeResult<CacheWriteOutput>>;
  "INFER.CACHE.INVALIDATE": NodeContract<CacheInvalidateInput, NodeResult<CacheInvalidateOutput>>;
  "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
  "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
  "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
  "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
  "CONTEXT.RAG.EMBED": NodeContract<ContextRagEmbedInput, ContextRagEmbedOutput>;
  "CONTEXT.RAG.RETRIEVE": NodeContract<ContextRagRetrieveInput, ContextRagRetrieveOutput>;
  "CONTEXT.RAG.RANK": NodeContract<ContextRagRankInput, ContextRagRankOutput>;
  "CONTEXT.SKILL": NodeContract<ContextSkillInput, ContextSkillOutput>;
  "MEMORY.GET": NodeContract<MemoryGetInput, NodeResult<MemoryGetOutput>>;
  "MEMORY.QUERY": NodeContract<MemoryQueryInput, NodeResult<MemoryQueryOutput>>;
  "MEMORY.SEARCH": NodeContract<MemorySearchInput, NodeResult<MemorySearchOutput>>;
  "MEMORY.WRITE": NodeContract<MemoryWriteInput, NodeResult<MemoryWriteOutput>>;
  "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, NodeResult<MemoryUpdateOutput>>;
  "MEMORY.DELETE": NodeContract<MemoryDeleteInput, NodeResult<MemoryDeleteOutput>>;
  "INTERACTION.ACT.TOOL": NodeContract<InteractionToolInput, InteractionToolOutput>;
  "INTERACTION.ACT.MCP": NodeContract<InteractionMcpInput, InteractionMcpOutput>;
  "INTERACTION.OBSERVE": NodeContract<InteractionObserveInput, InteractionObserveOutput>;
  "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
}
export type NodeType = keyof NodeContractMap;
export type InputOf<N extends NodeType> = NodeContractMap[N]["input"];
export type OutputOf<N extends NodeType> = NodeContractMap[N]["output"];
```

## 5. Implementation rules

- One `.ts` scaffold exists for every agreed leaf Node. A scaffold fixes identity and type binding without inventing business logic.
- INFER.CACHE is a namespace; LOOKUP, WRITE and INVALIDATE are implemented leaves.
- Providers live in `src/worker/infer/providers/`. Runtime and INFER share ModelProvider.invoke/stream and ProviderRegistry; see [Provider API](worker-api/providers.md). ReAct is a predefined Runtime graph flow, not an INFER strategy. Model/vendor changes do not create Nodes.
- `INTERACTION.ACT.TOOL` is represented by a source directory. Its `linux-commands/` child and registered command names are not Nodes.
- Tool and MCP registries remain distinct.
- The four predefined flows live in `src/runtime/graph.ts`; there is no `src/presets` package or export.
- Core remains dependency-light; databases, RPC, NATS, MCP SDKs, model SDKs, and distributed transports are optional adapters.
- The same Graph and Node Contracts must run across local and remote Workers without embedding deployment information.

## Optional RETRIEVAL extension

The four Core Workers retain 25 leaves. The optional `@ditto/core/worker/retrieval` entry adds the RETRIEVAL.SEARCH contract and implementation through explicit imports/registration. It invokes user providers through a Target/Strategy registry, owns no corpus, performs no RAG, and is not required by MEMORY/CONTEXT. Existing Runtime/HTTP facilities support independent deployment and replicas. See [API and deployment boundaries](worker-api/retrieval.md).
