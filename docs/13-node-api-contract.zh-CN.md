# Ditto 节点体系与 API Contract

[English](13-node-api-contract.md) · **简体中文**

> 节点体系：负责人最终确认<br>
> API Contract：`2.0-rc.1`，待负责人确认<br>
> 语言：TypeScript<br>
> 实现状态：目标规范；当前 `dev` 尚未迁移

本文是节点分类、能力边界、公共基础类型和输入输出的唯一权威文档。Node 只表达可独立编排和追踪的语义能力；算法 strategy、Provider、数据库、协议连接、部署位置和副本数不自动产生新 Node。

## 1. 最终节点体系

```text
INFER
├── REASONING
│   ├── TRAJECTORY
│   │   ├── CoT / ToT / GoT / ...  // strategy，不是 Node
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
└── CACHE
    └── ...                         // 三级 Node 另行确定

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
│   │   ├── Linux Commands/          // 工具目录，不是 Node
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

`INFER.REASONING`、`CONTEXT.RAG`、`MEMORY.RAG`、`INTERACTION.ACT`、`INTERACTION.ACT.TOOL/Linux Commands` 和 `INFER.CACHE` 是文件夹或能力命名空间。当前有 26 个已定义、可签订 Contract 的叶子 Node。`INFER.CACHE` 的三级叶子尚未商定，因此 CACHE 本身不可路由，本版也不虚构其 API。`grep`、`ls`、`cat`、`find` 等是 `ACT.TOOL` 的注册工具名，不是 Node Type。

## 2. 能力边界

- **INFER**：`REASONING.*` 是显式可控的推理组织，不是模型内部隐藏思维；模型调用由具体推理 Node 通过统一 Provider adapter 完成，不另设 GENERATE Node；`CACHE` 复用模型计算结果，不属于 Memory。
- **CONTEXT**：管理当前 invocation / turn 的 working set。`RESET` 属于 Runtime 生命周期；`ASSEMBLE` 是 Context → Infer 的内部 `ModelInput` 转换接口，二者都不是 Core Node。
- **CONTEXT.RAG**：检索当前文档、repo、网页、知识库或临时 corpus，结果进入当前 Context，不自动成为长期记忆。
- **MEMORY**：管理跨 invocation / session 持久存在的语义状态。`MEMORY.RETRIEVE` 按 id/key/filter 直接读取；`MEMORY.RAG.RETRIEVE` 对长期 Memory Corpus 做语义召回。
- **RAG**：Context 与 Memory 都拆为 `EMBED → RETRIEVE → RANK`。两套算法实现可以复用，但 corpus、权限、生命周期和 trace 必须可区分。cosine、BM25、ANN、hybrid 和 reranker 是 strategy；不存在 `RAG.GENERATE` 或独立 PACK Node。RANK 结果可由 Graph 绑定后交给 `CONTEXT.LOAD/UPDATE`。
- **SKILL**：`MEMORY.SKILL` 解析持久 procedural knowledge；`CONTEXT.SKILL` 激活并装入本轮 Context。暂不继续拆分三级 Node。
- **INTERACTION**：`ACT.TOOL` 调用直接注册工具，`ACT.MCP` 发现或调用 MCP 能力，`OBSERVE` 标准化外部结果，`COMMUNICATE` 面向外部 Actor，`OUTPUT` 提交最终结果。Linux Commands 只是 TOOL 下的注册目录，具体命令与其他工具共用 `InteractionToolInput/Output`。

MCP 连接、认证和 session 生命周期属于应用/Runtime。Worker 间 `invoke` / `emit` 属于 Runtime 内部通信，不属于 `INTERACTION.COMMUNICATE`。

## 3. 公共基础类型

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

`Reference` 支持大对象和 Artifact。Inline / Reference 的传输选择属于 Runtime。`ReasoningTraceEvent` 只包含可公开、可审计的摘要与证据引用，不要求暴露隐藏思维。

### 3.1 Provider adapter 边界

目标目录为 `src/worker/infer/providers/`。`ModelProvider` 是 Core 唯一依赖的供应商接口；各 `INFER.REASONING.*` handler 从执行上下文的 `ProviderResolver` 取得 adapter，再把 `ModelInput`、Runtime 选择的 model 和允许的工具 schema 组合为 `ProviderRequest`。Provider 名称、API Key、base URL、默认模型和超时不进入 Node 业务输入。

| Adapter | 负责转换 | 不得改变 |
| --- | --- | --- |
| OpenAI-compatible | chat/completions 消息、function tools、tool-call id、finish reason | `ModelInput` / `ModelOutput` 与 Node Contract |
| Anthropic | system/message 分离、content blocks、tool_use/tool_result | `ModelInput` / `ModelOutput` 与 Node Contract |
| 其他供应商 | 由可选 adapter 实现鉴权、请求和响应映射 | Node Type、Graph 与 Runtime 通信语义 |

Core 不默认依赖供应商 SDK。通用 HTTP adapter 可以保留；需要流式、多模态、供应商专属参数或 SDK 时，由可选 adapter 扩展，并在注册时声明其能力。供应商切换不产生新 Node，也不要求修改 Graph。

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

`INFER.CACHE` 暂无可执行 Contract；缓存键、读写、失效与三级 Node 必须在后续设计中一起确定。

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

`MEMORY.SKILL` 只解析持久 Skill。Skill 的发布、版本管理和删除留在应用管理面，等真实 trace 证明需要后再决定三级 Node。

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

## 8. 完整 NodeContractMap

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

## 9. 预定义 Context 入口组合

这里预定义四类可复用 Graph 组合，其中 RAG 按 corpus 语义拆成两个变体，共五条具体入口。它们**不是新的 Node Type**；每条组合都将已有源 Node 通过同一个强类型入口连接到 `CONTEXT.UPDATE`。

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

| 预定义组合 | 源输出 → `ContextIngress` | 必须保持的语义 |
| --- | --- | --- |
| Skill | `MEMORY.SKILL` → `CONTEXT.UPDATE` | 将 `Skill.instructions` 写入 `content`，在 metadata 中保留 name 与 version。只有当“激活 Skill”本身需要独立追踪的语义步骤时，才在 Graph 中使用 `CONTEXT.SKILL`。 |
| Context RAG | `CONTEXT.RAG.RANK` → `CONTEXT.UPDATE` | 每个排序后的 `RagCandidate` 生成一个 ingress item，保留 score、evidence source 与当前任务 corpus 来源。 |
| Memory RAG | `MEMORY.RAG.RANK` → `CONTEXT.UPDATE` | 每个排序后的 `MemoryRagCandidate` 生成一个 ingress item，保留 memory id/key、score 与长期记忆来源；必须能与 Context RAG 区分。 |
| Tool call | `INTERACTION.ACT.TOOL` → `CONTEXT.UPDATE` | 映射成功的 `ExternalResult`，保留 tool source、reference 与 metadata。只有当结果标准化需要成为显式 Graph 步骤时，才在更新前插入 `INTERACTION.OBSERVE`。 |
| MCP | `INTERACTION.ACT.MCP` → `CONTEXT.UPDATE` | `invoke` 映射 `ExternalResult`；`discover` 将 capability 列表编码为 JSON content，并保留 server/name 来源。 |

`ContextUpdateInput.ingress` 是这组预定义组合唯一的跨 Node 入口；`add` 仅保留给 Context 内生或应用直接提供的条目，上述五条流程的输出必须走 `ingress`。Adapter 必须分配稳定 `id`、原样保留 `sourceNode`、忽略失败或空结果，并让大对象通过 `reference` 传递。`CONTEXT.UPDATE` 负责校验并幂等合并 ingress item，但不重复执行检索、Tool、MCP 或 Skill 解析，也不得提升权限或写入长期 Memory。

Graph 可以在公共更新入口前插入策略、鉴权、`INTERACTION.OBSERVE` 或 `CONTEXT.SKILL` Node。插入行为只改变 Graph，不改变这些 Node Contract，也不改变源 Node 的语义身份。

## 10. 当前 dev 迁移与验收

| 当前实现 | 目标处理 |
| --- | --- |
| `REASONING.GENERATE` | 移除独立 Node；模型调用由具体 `INFER.REASONING.*` 实现承担 |
| `REASONING.INFER` | 显式推理路径归 `INFER.REASONING.TRAJECTORY` |
| `REASONING.REFLECT/DELIBERATE/SAMPLE` | 迁入 `INFER.REASONING.*` |
| `CONTEXT.RESET` | 移出 Core，归 Runtime 生命周期 |
| RAG 折叠进 Memory/Tool | 拆成 Context RAG 与 Memory RAG |
| `INTERACTION.SKILL` | 拆成 Memory Skill 与 Context Skill |
| `INTERACTION.TOOL` / MCP adapter | 迁为 `ACT.TOOL` / `ACT.MCP` |
| `INTERACTION.ACT` | 改为命名空间 |
| `INTERACTION.RUN` | 移出 NodeContractMap，归 Graph / Runtime 编排 |
| `src/worker/reasoning/providers/` | 迁至 `src/worker/infer/providers/`，统一实现 `ModelProvider.invoke` |

源码迁移完成时必须满足：`NodeContractMap` 恰好声明上述 26 个叶子；CACHE 在三级设计前不可路由；Linux Commands 只作为注册工具；旧节点名在编译期被拒绝；Context RAG 与 Memory RAG 的 corpus、权限和生命周期可由 trace 区分；OpenAI-compatible、Anthropic 和一个自定义假 Provider 通过同一 Contract 测试；中英文文档、源码导出、测试和实验仓库示例一致。
