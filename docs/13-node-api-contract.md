# Ditto Node Taxonomy and API Contract

**English** | [简体中文](13-node-api-contract.zh-CN.md)

> Status: final Node taxonomy; API Contract `2.0-rc.1`; TypeScript source skeleton initialized on `dev`.

This is the sole normative English document for the Node tree, semantic boundaries, common public types, and Node input/output contracts. A Node is a composable, independently executable semantic operation. A Worker is the implementation, resource, deployment, and scaling boundary. Graphs compose Nodes; Runtime schedules, routes, communicates, and executes them.

## 1. Final Node tree

```text
INFER
├── REASONING/                  // folder, not a Node
│   ├── TRAJECTORY
│   │   └── CoT / ToT / GoT / ...  // strategies, not Nodes
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
└── CACHE/                      // namespace skeleton
    └── ...                     // leaf Nodes will be defined separately

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
│   ├── TOOL/
│   │   ├── Linux Commands/     // tool folder, not a Node
│   │   │   ├── grep            // registered tool name
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

The tree defines exactly 26 routable leaf Node Contracts. `INFER.REASONING`, both `RAG` branches, `INTERACTION.ACT`, `Linux Commands`, and `INFER.CACHE` are folders or namespaces. `INFER.CACHE` exists in the source layout but is not routable until its leaf semantics are approved. Tool names and CoT/ToT/GoT strategies are not Node Types.

## 2. Semantic boundaries

- **INFER** owns model computation. `REASONING` organizes explicit reasoning; it is not hidden model thought. `TRAJECTORY` accepts CoT/ToT/GoT through `strategy`; `REFLECT` revisits a result; `DELIBERATE` adds compute budget; `SAMPLE` creates alternatives. There is no separate Generate Node. Providers are implementation adapters, not Nodes. `CACHE` reuses computation results and is not Memory.
- **CONTEXT** owns the working set of the current invocation or turn. `LOAD`, `SELECT`, `UPDATE`, and `COMPRESS` alter that working set. Reset/session lifecycle belongs to Runtime. Context-to-model assembly is an internal `ModelInput` boundary, not a Node.
- **CONTEXT.RAG** retrieves current-task knowledge from documents, repositories, web sources, knowledge bases, or temporary corpora. Its results are not durable by default.
- **MEMORY** owns semantic state across invocations or sessions. Direct `RETRIEVE` uses id/key/filter. `MEMORY.RAG` performs semantic recall over the durable Memory corpus.
- **RAG** uses `EMBED → RETRIEVE → RANK`. Algorithms may be shared, while corpus ownership, permissions, lifecycle, and trace identity remain different. Ranking/search algorithms are strategies. There is no `RAG.GENERATE` or `RAG.PACK` Node.
- **SKILL** has two lifecycles: `MEMORY.SKILL` resolves durable procedural knowledge; `CONTEXT.SKILL` activates a Skill in the current working context.
- **INTERACTION** owns semantic interaction with the outside world. `ACT.TOOL` calls registered native tools; `ACT.MCP` discovers or invokes MCP capabilities; `OBSERVE` standardizes external results; `COMMUNICATE` addresses external actors; `OUTPUT` submits the final result.

Worker-to-Worker `invoke` and `emit` are Runtime communication primitives, never `INTERACTION.COMMUNICATE`. Location and transport do not appear in Node Contracts.

## 3. Fixed common public types

The definitions below are the fixed public boundary for this Contract version.

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

export interface ModelInput { messages: readonly Message[]; context?: Context; responseFormat?: JsonObject; }
export interface ToolCall { id?: string; name: string; arguments: JsonObject; }
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonObject; }
export interface ModelUsage { inputTokens?: number; outputTokens?: number; }
export interface ModelOutput {
  message: Message; toolCalls?: readonly ToolCall[]; finishReason?: string; usage?: ModelUsage;
}
export interface ReasoningBudget { maxSteps?: number; maxTokens?: number; }
export interface ReasoningTraceEvent {
  step: number; kind: string; summary?: string; references?: readonly Reference[];
}
export interface ProviderRequest {
  model: string; input: ModelInput; tools?: readonly ToolDefinition[];
  maxTokens?: number; signal?: AbortSignal;
}
export interface ModelProvider { invoke(request: ProviderRequest): Promise<ModelOutput>; }
export interface ProviderResolver { get(name: string): ModelProvider; }

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
export type ActorKind = "user" | "agent" | "human-reviewer" | "service";
export interface Actor { id: string; kind: ActorKind; channel?: string; }
export interface CommunicationReceipt { accepted: boolean; recipients: readonly string[]; }
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability { server: string; name: string; description?: string; inputSchema?: JsonObject; }
```

## 4. Fixed Node inputs and outputs

```ts
export interface TrajectoryInput { input: ModelInput; strategy: string; budget?: ReasoningBudget; }
export interface TrajectoryOutput { result: ModelOutput; trace: readonly ReasoningTraceEvent[]; }
export interface ReflectInput { result: ModelOutput; context?: Context; criteria?: readonly Message[]; }
export type ReflectOutput = ModelOutput;
export interface DeliberateInput { input: ModelInput; budget: ReasoningBudget; alternatives?: readonly ModelOutput[]; }
export type DeliberateOutput = ModelOutput;
export interface SampleInput { input: ModelInput; count: number; }
export type SampleOutput = readonly ModelOutput[];

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
export interface InteractionCommunicateInput { message: Message; recipients: readonly Actor[]; }
export type InteractionCommunicateOutput = CommunicationReceipt;
export interface InteractionOutputInput { message: Message; artifacts?: readonly Artifact[]; }
export type InteractionOutputOutput = OutputReceipt;
```

```ts
export interface NodeContract<Input, Output> { readonly input: Input; readonly output: Output; }
export interface NodeContractMap {
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
export type NodeType = keyof NodeContractMap;
export type InputOf<N extends NodeType> = NodeContractMap[N]["input"];
export type OutputOf<N extends NodeType> = NodeContractMap[N]["output"];
```

## 5. Predefined cross-Node Context ingress

These presets standardize information entering `CONTEXT.UPDATE`; they do not create new Node Types or hide Graph steps.

| Preset ID | Source | Target |
| --- | --- | --- |
| `memory.skill-context.update` | `MEMORY.SKILL` | `CONTEXT.UPDATE` |
| `context.rag-context.update` | `CONTEXT.RAG.RANK` | `CONTEXT.UPDATE` |
| `memory.rag-context.update` | `MEMORY.RAG.RANK` | `CONTEXT.UPDATE` |
| `interaction.act.tool-context.update` | `INTERACTION.ACT.TOOL` | `CONTEXT.UPDATE` |
| `interaction.act.mcp-context.update` | `INTERACTION.ACT.MCP` | `CONTEXT.UPDATE` |

Every adapter produces `ContextIngress[]` with a stable id, preserved `sourceNode`, content/reference separation, and provenance metadata. Context RAG and Memory RAG remain distinguishable. `CONTEXT.UPDATE` only merges entries; it does not rerun source operations, grant permissions, or persist Memory.

## 6. Implementation rules

- One `.ts` scaffold exists for every agreed leaf Node. A scaffold fixes identity and type binding without inventing business logic.
- `INFER.CACHE` has a folder skeleton only. Adding it to `NodeContractMap` before leaf approval is forbidden.
- Provider adapters live under `src/worker/infer/providers/` and implement `ModelProvider.invoke`. Model/vendor changes do not create Nodes.
- Tool and MCP registries are distinct. Linux command names are ordinary registered tools.
- Core remains dependency-light; databases, RPC, NATS, MCP SDKs, model SDKs, and distributed transports are optional adapters.
- The same Graph and Node Contracts must run across local and remote Workers without embedding deployment information.
