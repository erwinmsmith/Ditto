# Ditto Node Taxonomy and API Contract

> The implemented [INFER API](worker-api/infer.md), including CACHE leaves, supersedes the initial INFER scaffold signatures below. Other Worker contracts remain as documented here.

**English** | [简体中文](13-node-api-contract.zh-CN.md)

> Status: final Node taxonomy; API Contract `2.0-rc.1`; TypeScript source skeleton initialized on `dev`.

This document and the linked INFER API define the Node tree, semantic boundaries, common public types, and Node input/output contracts. A Node is a composable, independently executable semantic operation. A Worker is the implementation, resource, deployment, and scaling boundary. Graphs compose Nodes; Runtime schedules, routes, communicates, and executes them.

## Runtime predefined flows

Ditto exposes four directly callable Runtime functions from `src/runtime/graph.ts`. They compose existing Nodes and update the current Context; they are not Nodes and do not appear in `NodeContractMap`.

| Function | Standard flow |
| --- | --- |
| `runRagFlow()` | `CONTEXT.RAG.RETRIEVE → CONTEXT.RAG.RANK → CONTEXT.UPDATE`, or `MEMORY.RAG.RETRIEVE → MEMORY.RAG.RANK → CONTEXT.UPDATE` according to `scope` |
| `runSkillFlow()` | `MEMORY.SKILL → CONTEXT.UPDATE` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP → CONTEXT.UPDATE` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL → CONTEXT.UPDATE` |

Each function receives a `RuntimeClient` and current `Context`, invokes the source Nodes, maps provenance into `ContextIngress`, calls `CONTEXT.UPDATE`, and returns `{ output, context }`. `runRagFlow()` requires `scope: "context" | "memory"` so the two corpora remain distinguishable. `EMBED` is an index-preparation operation and is not repeated automatically for each query. Stable ingress IDs, source identity, references, and metadata are preserved internally.

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
├── RETRIEVE
├── WRITE
├── UPDATE
├── CONSOLIDATE
├── EVICT
├── RAG/
│   ├── EMBED
│   ├── RETRIEVE
│   └── RANK
└── SKILL

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

There are 28 routable leaf contracts. INFER.REASONING, INFER.CACHE, INFER.PROVIDERS, RAG branches and INTERACTION.ACT are namespaces; CACHE executes through LOOKUP, WRITE and INVALIDATE. Tool names and reasoning strategies are not Nodes.

## 2. Semantic boundaries

- **INFER** owns model computation. `REASONING` organizes explicit reasoning; it is not hidden model thought. `TRAJECTORY` accepts CoT/ToT/GoT through `strategy`; `REFLECT` revisits a result; `DELIBERATE` compares/combines candidates; `SAMPLE` generates one candidate. There is no separate Generate Node. Providers are implementation adapters, not Nodes. `CACHE` reuses computation results and is not Memory.
- **CONTEXT** owns the working set of the current invocation or turn. `LOAD`, `SELECT`, `UPDATE`, and `COMPRESS` alter that working set. Reset/session lifecycle belongs to Runtime. Context-to-model assembly is an internal `ModelInput` boundary, not a Node.
- **CONTEXT.RAG** retrieves current-task knowledge from documents, repositories, web sources, knowledge bases, or temporary corpora. Its results are not durable by default.
- **MEMORY** owns semantic state across invocations or sessions. Direct `RETRIEVE` uses id/key/filter. `MEMORY.RAG` performs semantic recall over the durable Memory corpus.
- **RAG** uses `EMBED → RETRIEVE → RANK`. Algorithms may be shared, while corpus ownership, permissions, lifecycle, and trace identity remain different. Ranking/search algorithms are strategies. There is no `RAG.GENERATE` or `RAG.PACK` Node.
- **SKILL** has two lifecycles: `MEMORY.SKILL` resolves durable procedural knowledge; `CONTEXT.SKILL` activates a Skill in the current working context.
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
  | "MEMORY.SKILL" | "CONTEXT.RAG.RANK" | "MEMORY.RAG.RANK"
  | "INTERACTION.ACT.TOOL" | "INTERACTION.ACT.MCP";
export interface ContextIngress {
  id: string; sourceNode: ContextIngressSource; content: MessageContent;
  reference?: Reference; metadata?: JsonObject;
}

export interface MemoryDraft { key?: string; message: Message; metadata?: JsonObject; }
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemoryReference { id: string; }
export interface MemorySelector { ids?: readonly string[]; keys?: readonly string[]; filter?: JsonObject; }

export interface ToolCall { id?: string; name: string; arguments: JsonObject; }
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonObject; }
export interface KnowledgeItem { id: string; content: MessageContent; source?: Reference; metadata?: JsonObject; }
export interface EmbeddingRecord { itemId: string; vector: readonly number[]; }
export interface RagCandidate { item: KnowledgeItem; score?: number; }
export interface MemoryRagCandidate { memory: MemoryItem; score?: number; }
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
import type {
  NodeResult, TrajectoryInput, TrajectoryOutput, ReflectInput, ReflectOutput,
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

export interface MemoryRetrieveInput { selector: MemorySelector; limit?: number; }
export type MemoryRetrieveOutput = readonly MemoryItem[];
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
export interface MemoryUpdateEntry { id: string; message: Message; metadata?: JsonObject; }
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
export interface MemoryConsolidateInput { memories: readonly MemoryReference[]; strategy?: string; }
export type MemoryConsolidateOutput = readonly MemoryItem[];
export type MemoryEvictMode = "delete" | "invalidate" | "deprioritize";
export interface MemoryEvictInput { memories: readonly MemoryReference[]; mode: MemoryEvictMode; }
export type MemoryEvictOutput = readonly MemoryReference[];
export interface MemoryRagEmbedInput { memories: readonly MemoryItem[]; }
export type MemoryRagEmbedOutput = readonly EmbeddingRecord[];
export interface MemoryRagRetrieveInput {
  query: MessageContent; corpus?: Reference; limit?: number; strategy?: string;
}
export type MemoryRagRetrieveOutput = readonly MemoryRagCandidate[];
export interface MemoryRagRankInput {
  query: MessageContent; candidates: readonly MemoryRagCandidate[]; limit?: number; strategy?: string;
}
export type MemoryRagRankOutput = readonly MemoryRagCandidate[];
export interface MemorySkillInput { name: string; version?: string; }
export type MemorySkillOutput = Skill;

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
  "MEMORY.RETRIEVE": NodeContract<MemoryRetrieveInput, MemoryRetrieveOutput>;
  "MEMORY.WRITE": NodeContract<MemoryWriteInput, MemoryWriteOutput>;
  "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, MemoryUpdateOutput>;
  "MEMORY.CONSOLIDATE": NodeContract<MemoryConsolidateInput, MemoryConsolidateOutput>;
  "MEMORY.EVICT": NodeContract<MemoryEvictInput, MemoryEvictOutput>;
  "MEMORY.RAG.EMBED": NodeContract<MemoryRagEmbedInput, MemoryRagEmbedOutput>;
  "MEMORY.RAG.RETRIEVE": NodeContract<MemoryRagRetrieveInput, MemoryRagRetrieveOutput>;
  "MEMORY.RAG.RANK": NodeContract<MemoryRagRankInput, MemoryRagRankOutput>;
  "MEMORY.SKILL": NodeContract<MemorySkillInput, MemorySkillOutput>;
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
