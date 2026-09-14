# Ditto Node Taxonomy and API Contract

**English** · [简体中文](13-node-api-contract.zh-CN.md)

> Node taxonomy: finally approved by the project owner<br>
> API Contract: `2.0-rc.1`, pending project-owner confirmation<br>
> Language: TypeScript<br>
> Implementation: target specification; current `dev` is not migrated

This is the single authoritative document for node classification, capability boundaries, common types, and input/output Contracts. A Node represents an independently composable and traceable semantic capability. Strategies, providers, databases, protocol connections, deployment locations, and replica counts do not automatically create Nodes.

## 1. Final node taxonomy

```text
INFER
├── REASONING
│   ├── TRAJECTORY
│   │   ├── CoT / ToT / GoT / ...  // strategy, not a Node
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
└── CACHE
    └── ...                         // third-level Nodes defined separately

CONTEXT
├── LOAD
├── SELECT
├── UPDATE
├── COMPRESS
├── RAG
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
├── RAG
│   ├── EMBED
│   ├── RETRIEVE
│   └── RANK
└── SKILL

INTERACTION
├── ACT
│   ├── TOOL
│   │   ├── Linux Commands/          // tool folder, not a Node
│   │   │   ├── grep                 // registered tool name
│   │   │   ├── ls
│   │   │   ├── cat
│   │   │   ├── find
│   │   │   └── ...
│   │   └── other registered tools
│   └── MCP
├── OBSERVE
├── COMMUNICATE
└── OUTPUT
```

`INFER.REASONING`, `CONTEXT.RAG`, `MEMORY.RAG`, `INTERACTION.ACT`, `INTERACTION.ACT.TOOL/Linux Commands`, and `INFER.CACHE` are folders or capability namespaces. The taxonomy currently defines 26 executable leaf Contracts. The third-level leaves under `INFER.CACHE` are not agreed, so CACHE itself is not routable and this version does not invent its API. `grep`, `ls`, `cat`, `find`, and similar entries are registered tool names under ACT.TOOL, not Node Types.

## 2. Capability boundaries

- **INFER**: `REASONING.*` organizes explicit, controllable reasoning and is not hidden model thought. Concrete reasoning Nodes call models through one Provider adapter interface; there is no separate GENERATE Node. `CACHE` reuses model-computation results and is not Memory.
- **CONTEXT**: owns the working set for the current invocation or turn. `RESET` belongs to Runtime lifecycle. `ASSEMBLE` is the internal Context → Infer conversion to `ModelInput`; neither is a Core Node.
- **CONTEXT.RAG**: retrieves from current documents, repositories, web sources, knowledge bases, or temporary corpora. Results enter current Context and are not durable by default.
- **MEMORY**: owns semantic state that survives invocations or sessions. `MEMORY.RETRIEVE` directly addresses id/key/filter; `MEMORY.RAG.RETRIEVE` performs semantic recall over the durable Memory Corpus.
- **RAG**: both lifecycles use `EMBED → RETRIEVE → RANK`. Algorithms may be shared, but corpus ownership, permissions, lifecycle, and traces remain distinct. Cosine, BM25, ANN, hybrid, and rerankers are strategies. There is no `RAG.GENERATE` or standalone PACK Node. A Graph may bind ranked results into `CONTEXT.LOAD/UPDATE`.
- **SKILL**: `MEMORY.SKILL` resolves durable procedural knowledge; `CONTEXT.SKILL` activates it in the current Context. No third-level Skill Nodes are defined yet.
- **INTERACTION**: `ACT.TOOL` invokes directly registered tools; `ACT.MCP` discovers or invokes MCP capabilities; `OBSERVE` normalizes external results; `COMMUNICATE` targets external Actors; `OUTPUT` submits the final result. Linux Commands is only a TOOL registry folder; commands and other tools share `InteractionToolInput/Output`.

MCP connection, authentication, and session lifecycle remain application/Runtime concerns. Worker `invoke` / `emit` are Runtime-internal communication and never `INTERACTION.COMMUNICATE`.

## 3. Common public types

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface Reference {
  uri: string;
  mediaType?: string;
  digest?: string;
}
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message {
  role: MessageRole;
  content: MessageContent;
  name?: string;
}

export interface ContextItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
export interface Context { items: readonly ContextItem[]; }
export type ContextSource = Message | Reference | ContextItem;

export type ContextIngressSource =
  | "MEMORY.SKILL"
  | "CONTEXT.RAG.RANK"
  | "MEMORY.RAG.RANK"
  | "INTERACTION.ACT.TOOL"
  | "INTERACTION.ACT.MCP";
export interface ContextIngress {
  id: string;
  sourceNode: ContextIngressSource;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}

export interface MemoryDraft {
  key?: string;
  message: Message;
  metadata?: JsonObject;
}
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemoryReference { id: string; }
export interface MemorySelector {
  ids?: readonly string[];
  keys?: readonly string[];
  filter?: JsonObject;
}

export interface ModelInput {
  messages: readonly Message[];
  context?: Context;
  responseFormat?: JsonObject;
}
export interface ToolCall {
  id?: string;
  name: string;
  arguments: JsonObject;
}
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}
export interface ModelUsage { inputTokens?: number; outputTokens?: number; }
export interface ModelOutput {
  message: Message;
  toolCalls?: readonly ToolCall[];
  finishReason?: string;
  usage?: ModelUsage;
}
export interface ReasoningBudget { maxSteps?: number; maxTokens?: number; }
export interface ReasoningTraceEvent {
  step: number;
  kind: string;
  summary?: string;
  references?: readonly Reference[];
}

export interface ProviderRequest {
  model: string;
  input: ModelInput;
  tools?: readonly ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface ModelProvider {
  invoke(request: ProviderRequest): Promise<ModelOutput>;
}
export interface ProviderResolver {
  get(name: string): ModelProvider;
}

export interface KnowledgeItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
export interface EmbeddingRecord { itemId: string; vector: readonly number[]; }
export interface RagCandidate { item: KnowledgeItem; score?: number; }
export interface MemoryRagCandidate { memory: MemoryItem; score?: number; }
export interface Skill {
  name: string;
  version?: string;
  description?: string;
  instructions: MessageContent;
  metadata?: JsonObject;
}
export interface ExternalResult {
  source: string;
  content: MessageContent;
  reference?: Reference;
  metadata?: JsonObject;
}
export interface Observation { source: string; message: Message; }
export type ActorKind = "user" | "agent" | "human-reviewer" | "service";
export interface Actor { id: string; kind: ActorKind; channel?: string; }
export interface CommunicationReceipt {
  accepted: boolean;
  recipients: readonly string[];
}
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability {
  server: string;
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface NodeContract<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}
export interface NodeContractMap {}
export type NodeType = keyof NodeContractMap & string;
export type InputOf<T extends NodeType> = NodeContractMap[T]["input"];
export type OutputOf<T extends NodeType> = NodeContractMap[T]["output"];
```

`Reference` supports large values and artifacts; Inline versus Reference transport belongs to Runtime. `ReasoningTraceEvent` contains only publishable, auditable summaries and evidence references, not hidden model thought.

### 3.1 Provider adapter boundary

The target directory is `src/worker/infer/providers/`. `ModelProvider` is the only vendor interface Core depends on. Each `INFER.REASONING.*` handler resolves an adapter through the execution context's `ProviderResolver`, then combines `ModelInput`, the Runtime-selected model, and allowed tool schemas into a `ProviderRequest`. Provider name, API key, base URL, default model, and timeout never enter Node business input.

| Adapter | Converts | Must not change |
| --- | --- | --- |
| OpenAI-compatible | chat/completions messages, function tools, tool-call ids, and finish reasons | `ModelInput` / `ModelOutput` and Node Contracts |
| Anthropic | system/message separation, content blocks, and tool_use/tool_result | `ModelInput` / `ModelOutput` and Node Contracts |
| Other vendors | Optional adapters implement authentication and request/response mapping | Node Types, Graphs, and Runtime communication semantics |

Core has no mandatory vendor SDK dependency. A generic HTTP adapter may remain. Streaming, multimodal behavior, vendor-specific parameters, or SDK use belongs in optional adapters that declare their capabilities when registered. Switching vendors does not create a Node or require Graph changes.

## 4. INFER API

```ts
export interface TrajectoryInput {
  input: ModelInput;
  strategy: string;
  budget?: ReasoningBudget;
}
export interface TrajectoryOutput {
  result: ModelOutput;
  trace: readonly ReasoningTraceEvent[];
}
export interface ReflectInput {
  result: ModelOutput;
  context?: Context;
  criteria?: readonly Message[];
}
export type ReflectOutput = ModelOutput;
export interface DeliberateInput {
  input: ModelInput;
  budget: ReasoningBudget;
  alternatives?: readonly ModelOutput[];
}
export type DeliberateOutput = ModelOutput;
export interface SampleInput { input: ModelInput; count: number; }
export type SampleOutput = readonly ModelOutput[];
```

`INFER.CACHE` has no executable Contract yet. Cache keys, read/write semantics, invalidation, and third-level Nodes must be designed together.

## 5. CONTEXT API

```ts
export interface ContextLoadInput { sources: readonly ContextSource[]; }
export type ContextLoadOutput = Context;
export interface ContextSelectInput { context: Context; query: Message; limit?: number; }
export type ContextSelectOutput = Context;
export interface ContextUpdateInput {
  context: Context;
  add?: readonly ContextItem[];
  ingress?: readonly ContextIngress[];
  removeIds?: readonly string[];
}
export type ContextUpdateOutput = Context;
export interface ContextCompressInput {
  context: Context;
  maxTokens?: number;
  maxItems?: number;
}
export type ContextCompressOutput = Context;

export interface ContextRagEmbedInput { items: readonly KnowledgeItem[]; }
export type ContextRagEmbedOutput = readonly EmbeddingRecord[];
export interface ContextRagRetrieveInput {
  query: MessageContent;
  corpus: Reference | readonly KnowledgeItem[];
  limit?: number;
  strategy?: string;
}
export type ContextRagRetrieveOutput = readonly RagCandidate[];
export interface ContextRagRankInput {
  query: MessageContent;
  candidates: readonly RagCandidate[];
  limit?: number;
  strategy?: string;
}
export type ContextRagRankOutput = readonly RagCandidate[];
export interface ContextSkillInput { context: Context; skill: Skill; }
export type ContextSkillOutput = Context;
```

## 6. MEMORY API

```ts
export interface MemoryRetrieveInput { selector: MemorySelector; limit?: number; }
export type MemoryRetrieveOutput = readonly MemoryItem[];
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
export interface MemoryUpdateEntry {
  id: string;
  message: Message;
  metadata?: JsonObject;
}
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
export interface MemoryConsolidateInput {
  memories: readonly MemoryReference[];
  strategy?: string;
}
export type MemoryConsolidateOutput = readonly MemoryItem[];
export type MemoryEvictMode = "delete" | "invalidate" | "deprioritize";
export interface MemoryEvictInput {
  memories: readonly MemoryReference[];
  mode: MemoryEvictMode;
}
export type MemoryEvictOutput = readonly MemoryReference[];

export interface MemoryRagEmbedInput { memories: readonly MemoryItem[]; }
export type MemoryRagEmbedOutput = readonly EmbeddingRecord[];
export interface MemoryRagRetrieveInput {
  query: MessageContent;
  corpus?: Reference;
  limit?: number;
  strategy?: string;
}
export type MemoryRagRetrieveOutput = readonly MemoryRagCandidate[];
export interface MemoryRagRankInput {
  query: MessageContent;
  candidates: readonly MemoryRagCandidate[];
  limit?: number;
  strategy?: string;
}
export type MemoryRagRankOutput = readonly MemoryRagCandidate[];
export interface MemorySkillInput { name: string; version?: string; }
export type MemorySkillOutput = Skill;
```

`MEMORY.SKILL` resolves a durable Skill only. Publishing, version management, and deletion remain application management operations until real traces justify third-level Nodes.

## 7. INTERACTION API

```ts
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
export interface InteractionCommunicateInput {
  message: Message;
  recipients: readonly Actor[];
}
export type InteractionCommunicateOutput = CommunicationReceipt;
export interface InteractionOutputInput {
  message: Message;
  artifacts?: readonly Artifact[];
}
export type InteractionOutputOutput = OutputReceipt;
```

## 8. Complete NodeContractMap

```ts
declare module "@ditto/core" {
  interface NodeContractMap {
    "INFER.REASONING.TRAJECTORY": NodeContract<TrajectoryInput, TrajectoryOutput>;
    "INFER.REASONING.REFLECT": NodeContract<ReflectInput, ReflectOutput>;
    "INFER.REASONING.DELIBERATE": NodeContract<DeliberateInput, DeliberateOutput>;
    "INFER.REASONING.SAMPLE": NodeContract<SampleInput, SampleOutput>;
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
    "INTERACTION.COMMUNICATE": NodeContract<InteractionCommunicateInput, InteractionCommunicateOutput>;
    "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
  }
}
```

## 9. Predefined context-ingress compositions

These are four reusable Graph presets, with RAG split by corpus semantics into two variants. They are **not new Node Types**: each preset connects an existing source Node to `CONTEXT.UPDATE` through the same typed ingress boundary.

```ts
export interface ContextIngressAdapter<
  Source extends ContextIngressSource,
  Output,
> {
  readonly source: Source;
  readonly target: "CONTEXT.UPDATE";
  map(output: Output): readonly ContextIngress[];
}

export interface PredefinedContextFlowMap {
  "memory.skill-context.update": ContextIngressAdapter<
    "MEMORY.SKILL",
    MemorySkillOutput
  >;
  "context.rag-context.update": ContextIngressAdapter<
    "CONTEXT.RAG.RANK",
    ContextRagRankOutput
  >;
  "memory.rag-context.update": ContextIngressAdapter<
    "MEMORY.RAG.RANK",
    MemoryRagRankOutput
  >;
  "interaction.act.tool-context.update": ContextIngressAdapter<
    "INTERACTION.ACT.TOOL",
    InteractionToolOutput
  >;
  "interaction.act.mcp-context.update": ContextIngressAdapter<
    "INTERACTION.ACT.MCP",
    InteractionMcpOutput
  >;
}

export type PredefinedContextFlowId = keyof PredefinedContextFlowMap;
```

| Preset | Source output → `ContextIngress` | Required semantics |
| --- | --- | --- |
| Skill | `MEMORY.SKILL` → `CONTEXT.UPDATE` | Put `Skill.instructions` in `content`; retain name and version in metadata. `CONTEXT.SKILL` remains available when activation itself needs an independently traced semantic step. |
| Context RAG | `CONTEXT.RAG.RANK` → `CONTEXT.UPDATE` | Create one ingress item per ranked `RagCandidate`; preserve score, evidence source, and current-task corpus provenance. |
| Memory RAG | `MEMORY.RAG.RANK` → `CONTEXT.UPDATE` | Create one ingress item per ranked `MemoryRagCandidate`; preserve memory id/key, score, and durable-memory provenance. It must remain distinguishable from Context RAG. |
| Tool call | `INTERACTION.ACT.TOOL` → `CONTEXT.UPDATE` | Map the successful `ExternalResult`; preserve tool source, reference, and metadata. Use `INTERACTION.OBSERVE` before the update only when result normalization is an explicit Graph step. |
| MCP | `INTERACTION.ACT.MCP` → `CONTEXT.UPDATE` | For `invoke`, map `ExternalResult`; for `discover`, encode the capability list as JSON content with server/name provenance. |

`ContextUpdateInput.ingress` is the only cross-Node entry in this preset family. `add` remains for Context-native or application-supplied items; outputs from the five flows above must use `ingress`. The adapter assigns a stable `id`, keeps `sourceNode` intact, omits failed or empty results, and uses `reference` for large payloads. `CONTEXT.UPDATE` validates and merges ingress items idempotently, but does not rerun retrieval, tools, MCP, or Skill resolution; it also cannot elevate permissions or write durable Memory.

Graph authors may insert policy, authorization, `INTERACTION.OBSERVE`, or `CONTEXT.SKILL` Nodes before the common update boundary. Such insertion changes the Graph, not these Node Contracts or the semantic identity of the source Node.

## 10. Current dev migration and acceptance

| Current implementation | Target treatment |
| --- | --- |
| `REASONING.GENERATE` | Remove the separate Node; concrete `INFER.REASONING.*` implementations perform model calls |
| `REASONING.INFER` | Explicit reasoning paths become `INFER.REASONING.TRAJECTORY` |
| `REASONING.REFLECT/DELIBERATE/SAMPLE` | Move under `INFER.REASONING.*` |
| `CONTEXT.RESET` | Leave Core and become Runtime lifecycle |
| RAG folded into Memory/Tool | Split into Context RAG and Memory RAG |
| `INTERACTION.SKILL` | Split into Memory Skill and Context Skill |
| `INTERACTION.TOOL` / MCP adapter | Become `ACT.TOOL` / `ACT.MCP` |
| `INTERACTION.ACT` | Become a namespace |
| `INTERACTION.RUN` | Leave NodeContractMap for Graph / Runtime orchestration |
| `src/worker/reasoning/providers/` | Move to `src/worker/infer/providers/` and implement the unified `ModelProvider.invoke` interface |

Source migration is complete only when `NodeContractMap` declares exactly these 26 leaves; CACHE is unroutable until its third-level design exists; Linux Commands remain registered tools only; old names fail at compile time; traces distinguish Context RAG and Memory RAG corpora, permissions, and lifecycles; OpenAI-compatible, Anthropic, and one custom fake Provider pass the same contract suite; and bilingual docs, exports, tests, and experimental-repository examples agree.
