# Ditto 节点体系与 API Contract

> [详细 Worker API 与示例](worker-api/README.zh-CN.md)。

[English](13-node-api-contract.md) | **简体中文**


本文与 Worker API 共同定义节点树、语义边界、公共基础类型和节点输入输出契约。Node 是可组合、可独立执行的语义操作；Worker 是实现、资源、部署和扩容边界；Graph 组合 Node；Runtime 负责调度、路由、通信与执行。

## Runtime 预定义流程

Ditto 从 `src/runtime/graph.ts` 公开四个可直接调用的 Runtime 函数。它们组合既有 Node 并更新当前 Context，不是 Node，也不进入 `NodeContractMap`。

| 函数 | 标准流转 |
| --- | --- |
| `runRagFlow()` | `CONTEXT.SELECT` with `strategy: { kind: "rag" }` |
| `runSkillFlow()` | `CONTEXT.LOAD → CONTEXT.UPDATE` (optional merge) |
| `runMcpFlow()` | `discover` 只调用 MCP；`invoke` 执行 MCP → OBSERVE → CONTEXT.UPDATE |
| `runToolCallFlow()` | TOOL → OBSERVE → CONTEXT.UPDATE |

流程返回 `{ output, context }`，Tool/MCP invoke 还返回 observation。RAG output 为 ContextSelection；Skill 输入 sources，可选 context。Memory 搜索由用户 Graph 显式检查 NodeResult 并映射到 UPDATE。详见 [CONTEXT API](worker-api/context.zh-CN.md)。

## 1. 最终节点树

```text
INFER
├── REASONING/                  // 文件夹，不是 Node
│   ├── TRAJECTORY
│   │   └── CoT / ToT / GoT / ...  // strategy，不是 Node
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
├── CACHE/
│   ├── LOOKUP
│   ├── WRITE
│   └── INVALIDATE
└── PROVIDERS/                  // 实现目录，不是 Node

CONTEXT
├── LOAD
├── SELECT
├── UPDATE
└── COMPRESS

MEMORY
├── GET
├── QUERY
├── SEARCH
├── WRITE
├── UPDATE
└── DELETE

INTERACTION
├── ACT/
│   ├── TOOL
│   └── MCP
├── OBSERVE
└── OUTPUT
```

Core 当前包含 21 个可路由叶子 Contract。`INFER.REASONING`、`INFER.CACHE`、`INFER.PROVIDERS`、`RAG` 分支和 `INTERACTION.ACT` 都是命名空间；CACHE 的可执行叶子为 LOOKUP、WRITE、INVALIDATE。工具名与推理策略不是 Node。

## 2. 能力域边界

- **INFER** 负责模型计算。`REASONING` 组织显式可控的推理，不代表模型隐藏思维。`TRAJECTORY` 通过 `strategy` 承载 CoT/ToT/GoT；`REFLECT` 重新审视已有结果；`DELIBERATE` 增加推理预算；`SAMPLE` 从同一输入产生候选。不存在独立 Generate Node。Provider 是实现适配器，不是 Node。`CACHE` 复用模型计算结果，不属于 Memory。
- **CONTEXT** 负责当前 invocation/turn 的 working set。`LOAD`、`SELECT`、`UPDATE`、`COMPRESS` 只改变当前上下文。Reset/session 生命周期归 Runtime。Context 到模型输入的组装是内部 `ModelInput` 边界，不是 Node。
- **MEMORY** 提供 GET / QUERY / SEARCH / WRITE / UPDATE / DELETE，通过注入的 MemoryStore / MemorySearchProvider 访问长期记忆。数据库由外部插件提供。
- **RAG** 是 CONTEXT.SELECT 的内部策略，embed/retrieve/rank 为可替换服务；独立执行可委托 RETRIEVAL。
- **SKILL** 由应用解析为 sources，经 LOAD/UPDATE 装入；MEMORY 不管理 Skill。
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
export interface ContextIngress {
  id: string; sourceNode: NodeType; content: MessageContent;
  reference?: Reference; metadata?: JsonObject;
}

export interface MemoryDraft { key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemorySearchResult { memory: MemoryItem; score?: number; metadata?: Record<string, unknown>; }

export interface ToolCall { id: string; name: string; arguments: JsonObject; }
export type ToolEffect = "read" | "write" | "execute" | "network";
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonObject; effects?: readonly ToolEffect[]; requiresApproval?: boolean; }
export interface ExternalResult {
  callId: string; source: string; status: "success" | "failed" | "cancelled" | "timeout" | "unknown";
  content?: MessageContent; structuredContent?: JsonValue; references?: readonly Reference[];
  error?: { code: string; message: string; retryable?: boolean }; metadata?: JsonObject;
}
export interface Observation extends Omit<ExternalResult, "content"> { message: Message; }
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { deliveryId: string; status: "accepted" | "rejected" | "unknown"; artifacts?: readonly Artifact[]; error?: { code: string; message: string; retryable?: boolean }; metadata?: JsonObject; }
export interface McpCapability { server: string; name: string; description?: string; inputSchema?: JsonObject; outputSchema?: JsonObject; }
```

## 4. 固定节点输入输出

```ts
import type { NodeResult } from "@ditto/core/contracts";
import type {
  TrajectoryInput, TrajectoryOutput, ReflectInput, ReflectOutput,
  DeliberateInput, DeliberateOutput, SampleInput, SampleOutput,
  CacheLookupInput, CacheLookupOutput, CacheWriteInput, CacheWriteOutput,
  CacheInvalidateInput, CacheInvalidateOutput,
} from "@ditto/core/worker/infer";

// Node inputs include explicit-context and scoped-cache calls.
import type { ContextInput, ContextOutput } from "@ditto/core/worker/context";
type ContextLoadInput = ContextInput<"CONTEXT.LOAD">;
type ContextLoadOutput = ContextOutput<"CONTEXT.LOAD">;
type ContextSelectInput = ContextInput<"CONTEXT.SELECT">;
type ContextSelectOutput = ContextOutput<"CONTEXT.SELECT">;
type ContextUpdateInput = ContextInput<"CONTEXT.UPDATE">;
type ContextUpdateOutput = ContextOutput<"CONTEXT.UPDATE">;
type ContextCompressInput = ContextInput<"CONTEXT.COMPRESS">;
type ContextCompressOutput = ContextOutput<"CONTEXT.COMPRESS">;

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
export interface InteractionOutputInput { deliveryId: string; message: Message; artifacts?: readonly Artifact[]; }
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

## 5. 实现规则

- 每个已确定的叶子 Node 都有 `.ts` 骨架；骨架只固定语义身份和类型绑定，不预设业务实现。
- `INFER.CACHE` 是命名空间，已实现的叶子为 LOOKUP、WRITE、INVALIDATE。
- Provider 位于 `src/worker/infer/providers/`。Runtime 与 INFER 统一使用 `ModelProvider.invoke/stream` 和 `ProviderRegistry`，详见 [Provider API](worker-api/providers.zh-CN.md)。ReAct 是 Runtime 的预定义 Graph 流程，不属于 INFER 策略。模型/供应商变化不产生 Node。
- `INTERACTION.ACT.TOOL` 在源码中使用目录表示；应用在 Worker 内注册工具或命令实现，具体工具名不是 Node。
- Tool 与 MCP registry 保持独立。
- 四个预定义流程位于 `src/runtime/graph.ts`；不再存在 `src/presets` package 或导出。
- Core 保持轻依赖；数据库、RPC、NATS、MCP SDK、模型 SDK 与分布式 transport 都作为可选适配器。
- 同一 Graph 与 Node Contract 必须能在本地或远端 Worker 间迁移，且不嵌入部署信息。

## 可选 RETRIEVAL 扩展

四个 Core Worker 的 21 个叶子保持不变。可选入口 `@ditto/core/worker/retrieval` 增加 `RETRIEVAL.SEARCH` 的契约与实现，仅在应用显式导入/注册时启用。它通过 Target/Strategy Registry 调用用户 Provider，不拥有数据、不执行 RAG，也不要求 MEMORY/CONTEXT 经由它检索。需要独立执行资源或水平扩容时，可使用现有 Runtime/HTTP 部署多个副本。[详细 API 与部署边界](worker-api/retrieval.zh-CN.md)。
