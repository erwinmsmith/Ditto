# Ditto 节点体系与 API Contract

[English](13-node-api-contract.md) | **简体中文**

> 状态：节点体系最终版；API Contract `2.0-rc.1`；TypeScript 源码骨架已在 `dev` 初始化。

本文是节点树、语义边界、公共基础类型和节点输入输出契约的唯一中文规范。Node 是可组合、可独立执行的语义操作；Worker 是实现、资源、部署和扩容边界；Graph 组合 Node；Runtime 负责调度、路由、通信与执行。

## Runtime 预定义流程

Ditto 从 `src/runtime/graph.ts` 公开四个可直接调用的 Runtime 函数。它们组合既有 Node 并更新当前 Context，不是 Node，也不进入 `NodeContractMap`。

| 函数 | 标准流转 |
| --- | --- |
| `runRagFlow()` | 根据 `scope` 执行 `CONTEXT.RAG.RETRIEVE → CONTEXT.RAG.RANK → CONTEXT.UPDATE`，或 `MEMORY.RAG.RETRIEVE → MEMORY.RAG.RANK → CONTEXT.UPDATE` |
| `runSkillFlow()` | `MEMORY.SKILL → CONTEXT.UPDATE` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP → CONTEXT.UPDATE` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL → CONTEXT.UPDATE` |

每个函数接收 `RuntimeClient` 和当前 `Context`，调用来源 Node，将来源信息映射为 `ContextIngress`，调用 `CONTEXT.UPDATE`，并返回 `{ output, context }`。`runRagFlow()` 必须使用 `scope: "context" | "memory"` 区分两类 corpus。`EMBED` 属于索引准备操作，不在每次查询时自动重复执行。稳定 ingress ID、来源 Node、reference 与 metadata 由流程函数内部保留。

## 1. 最终节点树

```text
INFER
├── REASONING/                  // 文件夹，不是 Node
│   ├── TRAJECTORY
│   │   └── CoT / ToT / GoT / ...  // strategy，不是 Node
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
├── CACHE/                      // 命名空间骨架
│   └── ...                     // 叶子 Node 另行确定
└── PROVIDERS/                  // 实现目录，不是 Node

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
│   ├── TOOL/                   // 源码目录；ACT.TOOL 仍是语义 Node
│   │   ├── Linux Commands/     // 工具目录，不是 Node
│   │   │   ├── grep            // 注册工具名
│   │   │   ├── ls
│   │   │   ├── cat
│   │   │   ├── find
│   │   │   └── ...
│   │   └── other registered tools
│   └── MCP
├── OBSERVE
└── OUTPUT
```

节点树严格定义 25 个可路由叶子 Node Contract。`INFER.REASONING`、两类 `RAG`、`INTERACTION.ACT`、`Linux Commands`、`INFER.CACHE` 和 `INFER.PROVIDERS` 是文件夹或能力命名空间。`INFER.CACHE` 在叶子语义确定前不可路由。`INFER.PROVIDERS` 保持当前扁平 Provider 适配目录，不定义供应商子树，也不产生 Node Type。工具名以及 CoT/ToT/GoT 都不是 Node Type。

## 2. 能力域边界

- **INFER** 负责模型计算。`REASONING` 组织显式可控的推理，不代表模型隐藏思维。`TRAJECTORY` 通过 `strategy` 承载 CoT/ToT/GoT；`REFLECT` 重新审视已有结果；`DELIBERATE` 增加推理预算；`SAMPLE` 从同一输入产生候选。不存在独立 Generate Node。Provider 是实现适配器，不是 Node。`CACHE` 复用模型计算结果，不属于 Memory。
- **CONTEXT** 负责当前 invocation/turn 的 working set。`LOAD`、`SELECT`、`UPDATE`、`COMPRESS` 只改变当前上下文。Reset/session 生命周期归 Runtime。Context 到模型输入的组装是内部 `ModelInput` 边界，不是 Node。
- **CONTEXT.RAG** 检索当前任务知识，来源可为文档、repo、网页、知识库或临时 corpus，结果默认不持久化。
- **MEMORY** 负责跨 invocation/session 的持久语义状态。普通 `RETRIEVE` 按 id/key/filter 直接读取；`MEMORY.RAG` 在长期 Memory Corpus 上做语义召回。
- **RAG** 固定为 `EMBED → RETRIEVE → RANK`。两类 RAG 可共用算法，但 corpus 所有权、权限、生命周期与 trace 身份必须区分。搜索和排序算法属于 strategy。不存在 `RAG.GENERATE` 或 `RAG.PACK` Node。
- **SKILL** 有两种生命周期：`MEMORY.SKILL` 解析持久 procedural knowledge；`CONTEXT.SKILL` 在当前 working context 中激活 Skill。
- **INTERACTION** 负责与外部世界的语义交互。`ACT.TOOL` 调用直接注册工具；`ACT.MCP` 发现或调用 MCP 能力；`OBSERVE` 标准化外部结果；`OUTPUT` 提交最终结果。

任务和用户输入通过应用/Runtime 边界进入，不设置独立通信 Node。确实需要调用外部消息系统时，应使用注册 Tool 或 MCP 能力。Worker 之间的 `invoke` / `emit` 仍是 Runtime 内部通信。Node Contract 不包含位置和传输信息。

## 3. 固定公共基础类型

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
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { accepted: boolean; artifacts?: readonly Artifact[]; }
export interface McpCapability { server: string; name: string; description?: string; inputSchema?: JsonObject; }
```

## 4. 固定节点输入输出

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
  "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
}
export type NodeType = keyof NodeContractMap;
export type InputOf<N extends NodeType> = NodeContractMap[N]["input"];
export type OutputOf<N extends NodeType> = NodeContractMap[N]["output"];
```

## 5. 实现规则

- 每个已确定的叶子 Node 都有 `.ts` 骨架；骨架只固定语义身份和类型绑定，不预设业务实现。
- `INFER.CACHE` 目前只有目录骨架；叶子契约确定前禁止加入 `NodeContractMap`。
- Provider adapter 保持扁平放置在 `src/worker/infer/providers/`，统一实现 `ModelProvider.invoke`。更换模型或供应商不新增 Node。
- `INTERACTION.ACT.TOOL` 在源码中使用目录表示；其 `linux-commands/` 子目录和注册命令名都不是 Node。
- Tool 与 MCP registry 保持独立。
- 四个预定义流程位于 `src/runtime/graph.ts`；不再存在 `src/presets` package 或导出。
- Core 保持轻依赖；数据库、RPC、NATS、MCP SDK、模型 SDK 与分布式 transport 都作为可选适配器。
- 同一 Graph 与 Node Contract 必须能在本地或远端 Worker 间迁移，且不嵌入部署信息。
