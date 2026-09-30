# INFER Worker API

[English](infer.md) · **简体中文** · [接口目录](README.zh-CN.md)

本文对应 `src/worker/infer/` 的实际实现。INFER 提供模型采样、推理轨迹、反思、候选审议和显式推理缓存。Context / Memory 默认由 Graph 提前传入；工具、MCP、Shell 等能力由其他 Worker 执行。INFER 不直接导入其他 Worker 的实现。

从 `@codesoul-co/ditto/worker/infer` 导入 INFER 契约，或通过根入口 `Infer` 类型命名空间访问。Graph 负责将 Context / Memory 输出转换为 INFER 所需的字段。

## 功能选择与参数影响

### 按任务选择 Node

以下使用完整 Node ID；`SAMPLE` 等简称仅用于说明。四个 REASONING Node 都通过 Provider 生成内容，三个 CACHE Node 只操作显式缓存。

| Node | 适合的任务 | 决定行为的参数 | 对执行和 Worker 的影响 |
| --- | --- | --- | --- |
| `INFER.REASONING.SAMPLE` | 回答、分类、提取、规划、生成文本或动作请求 | `messages`、`model`、`generation`、`actions` | 一次生成一个响应；内置 OpenAI 兼容和 Gemini 适配器固定为一个候选。动作请求需要交给 INTERACTION 执行 |
| `INFER.REASONING.TRAJECTORY` | 在同一推理任务中推进多个阶段、搜索备选解法或做独立答案投票 | `strategy`、`constraints`、`objective`、`context`、`memory` | 一次 Node 调用可能发出多次模型请求；共享该调用的预算、超时和 Worker 入口槽位 |
| `INFER.REASONING.REFLECT` | 检查已有答案、计划、轨迹或产物，或提出修订 | `target`、`mode`、`criteria`、参考资料 | 一次模型审查并解析结构化结果；结果是模型评估，关键事实与权限仍需确定性核验 |
| `INFER.REASONING.DELIBERATE` | 对已生成的候选排序、选择、融合或整理分歧 | `candidates`、原始任务、`mode`、`selectCount` | 一次模型审议；不会自动生成候选。`select` 的 `result` 是排名第一的原候选，多个入选 ID 在 `selectedCandidateIds` 中返回 |
| `INFER.CACHE.LOOKUP` | 在调用模型前检查可复用结果 | `key.namespace`、`key.scope`、`key.key` | 命中返回已有值；未命中返回 `hit:false`，不会自动调用 SAMPLE |
| `INFER.CACHE.WRITE` | 在校验后保存可复用的推理结果 | `value`、`key`、`ttlMs`、`tags` | 写入缓存后端；不会写入 MEMORY，也不会自动缓存其他 Node 的结果 |
| `INFER.CACHE.INVALIDATE` | 资料、提示或模型改变后移除旧结果 | `selector` 的 key / tag / namespace | 精确或批量失效；范围越大，后续应用缓存未命中和模型调用可能越多 |

### 生成参数：稳定性、多样性与输出预算

这些参数影响模型解码。它们不改变 SAMPLE 的候选数量，也不决定工具权限。表内范围是 Ditto 校验范围；模型可能只支持其中一部分。

| 参数 | 调整后的行为 | 取舍与边界 |
| --- | --- | --- |
| `temperature`，0–2 | 对支持该参数的模型，较低值通常使输出更集中；较高值增加采样随机性，可能产生更不同的措辞和解法 | 较高值也可能增加偏离格式或资料的概率；不代表置信度更低或必然覆盖更多正确答案。0 也不保证逐字复现 |
| `topP`，0–1 | 按累计概率质量限制可选 token；降低值通常收窄选择，提高值允许更多低概率选项 | 与温度共同作用；先单独调整一个主要采样参数，避免无法判断是哪项改变了结果 |
| `topK`，正整数 | 在支持的模型中限制为概率最高的 K 个 token；较小 K 收窄选择 | 不是检索返回数量；更大的 K 不会增加事实资料。OpenAI 兼容适配器会发送 `top_k`，实际端点可能拒绝；Gemini 也按具体模型决定是否接受 |
| `maxTokens`，正整数 | 限制单次生成输出预算；增大可以容纳更长答案、JSON 或修订 | 不会要求模型用满预算，也不增加输入窗口。过小可能出现 `finishReason:"length"`；某些模型把内部推理 token 计入输出预算 |
| `stop`，非空字符串数组 | 模型遇到停止序列时提前结束 | 可以约束分隔边界，也可能截断 JSON 或正文。`finishReason:"stop"` 不替代完整性与格式校验 |
| `seed`，安全整数 | 支持时提供重复实验的采样种子 | 仍受模型版本、端点和其他参数影响；不能保证确定性。内置 Anthropic 适配器明确拒绝 `generation.seed` |

采样语义和模型支持情况参考 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 与 [Gemini GenerationConfig](https://ai.google.dev/api/generate-content#generationconfig)。使用具体模型时先检查它的参数支持；不要把一套温度配置原样应用于所有模型。Ditto 省略生成字段时不会统一补成温度 1；Worker 默认值和 Provider / 模型默认值另行生效。

### 输入设计同样改变结果

| 参数 | 对 Node 的影响 | 对下游流程的影响 |
| --- | --- | --- |
| `messages` 的角色、顺序和内容 | 定义任务、约束、资料与历史；输入更长通常增加输入 token 和处理负担 | 显式标记不可信资料，说明输出结构，避免让外部文本成为高优先级指令；温度无法补救缺失事实 |
| `model.provider` / `model.model` | 选择已注册适配器与模型；模型能力和原生多模态格式决定可处理的输入 | 可能改变成本、时延、上下文窗口及动作支持；换模型后重新评估相同任务和输出校验 |
| `model.providerOptions` | 向适配器提供供应商专用字段 | 不会自动变为跨模型通用能力；核心请求字段和显式生成字段可能覆盖对应值，不能用 `n` 绕过单候选契约 |
| SAMPLE `actions[].description` / `inputSchema` | 帮助模型选择动作和构造参数 | 声明只提供模型可见协议，参数仍需工具验证器核验；SAMPLE 检查请求名已声明，目标由可信调用方绑定 |
| `metadata` | 提供调用元数据，具体用途由适配器约定 | 当前内置 HTTP 协议不会把顶层 `metadata` 自动作为提示或请求元数据发送；需模型理解的内容应放入明确的消息字段 |
| REFLECT `criteria`、`target` / DELIBERATE `objective`、`messages` | 明确评审标准及原始任务，降低“比较了候选但忘记目标”的风险 | `criteria.weight` 和候选 `score` 是给模型的数据，不是框架自动计算的确定性加权总分 |

### 多步推理：哪些参数增加实际模型调用

下表是内置策略无错误、无预算提前停止时的行为。策略中的候选调用当前按顺序执行；增加 Worker `concurrency` 不会把一次 TRAJECTORY 内的循环改为并行。

| 策略 / 参数 | 默认值 | 增大后的影响 |
| --- | --- | --- |
| `cot.options.rounds` / `long-cot.options.rounds` | 2 / 4，允许 1–64 | 每轮调用一次模型，后续轮次携带已有结果；输入历史和累计耗时增加，不保证推理更正确 |
| `self-consistency.options.candidates` | 3，允许 1–16 | 独立生成对应数量的答案，再做确定性答案投票；没有额外模型裁判，票数最高并列会失败 |
| `tot.options.breadth` / `depth` / `beamWidth` | 3 / 2 / 2，各允许 1–16 | breadth 增加每个保留状态的备选数，depth 增加层数，beamWidth 增加后续扩展的状态；每层还需要一次模型排序 |
| `got.options.breadth` / `depth` | 3 / 2，各允许 1–16 | 每层生成 breadth 个观点并做一次模型融合，总调用数为 `depth * (breadth + 1)` |
| `constraints.maxSteps` | 16，正整数 | 限制本次 TRAJECTORY 的实际模型调用数，排序/融合也计数；不是 `steps.length` 或 Loop 的 Graph 执行数 |
| `constraints.maxTotalTokens` | 未设置 | 限制累计输入和输出用量，需要每次 Provider 返回可用 usage；缩小可能返回 partial，大输入仍可能使最终用量超过预算 |
| `constraints.timeoutMs` | 继承配置，且受调用 deadline 限制 | 增大只有在其他有效时限允许时才延长运行；增加预算不重新启动已停止调用 |

例如 ToT 的 breadth=3、depth=2、beamWidth=2，需要 `3 + 1 + 2*3 + 1 = 11` 次模型调用，其中 2 次用于排序。`maxSteps:4` 会阻止完成这条路径；提高温度不会改变这个调用数量。若要并行生成多个候选，使用多个 SAMPLE 分支组成 Graph，再调用 DELIBERATE；见[多候选流程](candidate-workflows.zh-CN.md)。

REFLECT 的 `critique` 用于问题识别，`verify` 要求返回是否通过，`revise` 要求返回修订结果；一次调用不会自行反复检查。DELIBERATE 的 `select` 保留原候选，`merge` 生成综合结果，`consensus` 组织共识与不确定性，`debate` 对比异议；这些模式都不自动启动其他 Agent。重复评审和停止条件由 Loop 控制。

### Worker 默认值、缓存与资源占用

普通生成参数按“本次 `generation` 字段 → 生效的 Worker generation 默认字段 → 适配器/模型默认”解析。DELIBERATE 还在普通 generation 默认之上叠加 `defaults.deliberate.generation`，最后由本次字段覆盖。显式 `createInferWorker({defaults})` 替换 Runtime infer 默认对象；它不是与 YAML 自动深度合并，需保留的分组应一并传入。

请求参数不修改副本配置。Worker `concurrency` 限制同时接收的 Node 调用；一条长轨迹占一个入口槽位，但内部可能调用模型很多次。增加槽位可以提高独立任务吞吐，也可能触及供应商速率限制。SDK 直接调用不使用 Runtime 的副本并发调度。超时限制等待和合作取消；自定义 Provider 必须使用 signal 才能停止底层 I/O。

默认内存推理缓存最多保留 1000 项，各 SDK / 副本独立。对该后端，`ttlMs` 省略表示无到期时间但仍可能被 LRU 淘汰，0 会删除同键旧值且不保留新值，较长 TTL 提高复用机会也延长旧资料的影响。应用缓存键应绑定模型、生成参数、提示版本和资料版本；请求不同但键相同可能返回旧结果。较高温度的探索若每次都复用同一缓存值，也不会产生新的多样性。

### 按场景评估配置

先使用模型建议的默认值，再在它支持温度调节时尝试下列起点；它们是实验配置，不是 Ditto 默认值或质量保证。

| 场景 | 可以尝试的设计 | 应检查的结果 |
| --- | --- | --- |
| 分类、字段提取、工具参数、主管决策 | 低温度（例如 0–0.2）、明确结构、足够输出预算 | schema、业务约束、工具权限、错误和截断率；低温度不保证事实正确 |
| 文案和方案探索 | 较高温度（例如 0.7–1）、不同角度的提示、多个 SAMPLE 分支 | 候选差异、目标覆盖和可执行性，再低温度审议；单次随机输出不等于覆盖多个方案 |
| 有引用的事实问答 | CONTEXT / 检索提供证据，要求逐项引用并检查 | 答案与原文一致性、资料缺口；调高温度不会扩大检索范围 |
| 长推理或修订 | 同时设调用数、累计 token、超时和 Loop 上限 | 内外两层 status、stopReason、实际用量和最终任务完成度 |

## 1. 接入与生命周期

```ts
import { createDitto, createInfer, createInferWorker,
  createHttpProvider } from "@codesoul-co/ditto";

const runtime = createDitto({ sandbox: { network: ["https://api.openai.com"] } });
runtime.services.providers.register("openai", createHttpProvider({
  kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  sandbox: runtime.services.sandbox,
}));
runtime.register(createInferWorker());
const infer = createInfer({ runtime });
const input = {
  messages: [{ role: "user" as const, content: "Explain the tradeoffs." }],
  model: { provider: "openai", model: "your-model-name" },
};
const direct = await infer.reasoning.sample(input);
const routed = await runtime.invoke("INFER.REASONING.SAMPLE", input);
console.log(direct.output?.message, routed.status);
await runtime.close();
```

`createInfer` 在本地执行相同的 Node handler；它不是已注册 Worker 的远程代理。每个 SDK 实例及每个 Worker 副本默认拥有独立缓存。要让 SDK、多个副本或不同进程读取同一缓存，必须注入共享 `cache` 后端。SDK 没有后台定时任务；每次调用结束清理 deadline timer。注入的 Provider / 缓存连接由调用者管理和关闭。

| `InferOptions` 字段 | 含义 / 默认值 |
| --- | --- |
| `providers?: ProviderRegistry \| Readonly<Record<string, ModelProvider>>` | 统一 Registry 或按名称注入的模型适配器；省略时使用 Runtime 的 services.providers，否则为空 |
| `defaultProvider?: string` | 选择顺序：`input.model.provider` → 此字段 → Runtime config.model.provider → 唯一已注册 Provider；不能确定时失败 |
| `runtime?: { services: RuntimeServices }` | 共享 Runtime 的 Provider Registry 和默认供应商配置 |
| `cache?: InferCacheProvider` | 默认 `new InMemoryInferCache()` |
| `strategies?: Record<string, TrajectoryStrategy>` | 自定义策略；同名条目覆盖内置策略，名称区分大小写 |
| `defaults?: InferSettings` | 整体替换 Runtime 的 infer 默认配置；省略时继承 Runtime YAML 配置 |
| `timeoutMs?: number` | 单次调用总时限：优先使用此字段，否则使用 Runtime config.timeoutMs，没有 Runtime 时为 30,000 ms；正整数，最大 `2^31-1` |

执行器在每个实例创建时初始化一次；每次调用按当前 Registry 解析 Provider；每次调用独立创建执行上下文、预算和取消信号，避免并发请求串用上下文。流式事件按批次排出队列，避免逐条移动数组。

`createInferWorker(options)` 使用 `InferWorkerOptions`：包含以上字段但没有 `runtime`；Provider 配置使用 Runtime 注入的 `ctx.services`。额外支持 `cacheFactory?: () => InferCacheProvider`（每副本调用一次、优先于 `cache`）和 `concurrency?: number`（正整数，默认不限）。内部调用 SAMPLE 不额外占用 Worker 路由并发槽，因此 `concurrency: 1` 可执行完整轨迹。

## 2. Node 与调用契约

| Typed API | Node ID | Input → Output | 流式 |
| --- | --- | --- | --- |
| `reasoning.sample()` | `INFER.REASONING.SAMPLE` | `SampleInput → SampleOutput` | 是 |
| `reasoning.trajectory()` | `INFER.REASONING.TRAJECTORY` | `TrajectoryInput → TrajectoryOutput` | 是 |
| `reasoning.reflect()` | `INFER.REASONING.REFLECT` | `ReflectInput → ReflectOutput` | 是 |
| `reasoning.deliberate()` | `INFER.REASONING.DELIBERATE` | `DeliberateInput → DeliberateOutput` | 是 |
| `cache.lookup()` | `INFER.CACHE.LOOKUP` | `CacheLookupInput → CacheLookupOutput` | 否 |
| `cache.write()` | `INFER.CACHE.WRITE` | `CacheWriteInput → CacheWriteOutput` | 否 |
| `cache.invalidate()` | `INFER.CACHE.INVALIDATE` | `CacheInvalidateInput → CacheInvalidateOutput` | 否 |

每个方法返回 `Promise<NodeResult<Output>>`，支持第二参数 `InferCallOptions`。Runtime 的 `invoke` 返回同样的包，不再额外嵌套；`INFER`、`INFER.REASONING`、`INFER.CACHE` 和策略名均不能路由。

```ts
import type { SampleInput, SampleOutput } from "@codesoul-co/ditto/worker/infer";
const result = await infer.execute("INFER.REASONING.SAMPLE", input);
// 动态调用方可显式指定类型，仍会进行运行时输入校验：
const dynamic = await infer.execute<SampleInput, SampleOutput>(
  "INFER.REASONING.SAMPLE", input,
);
const controller = new AbortController();
const pending = infer.reasoning.sample(input, {
  signal: controller.signal, timeoutMs: 5_000,
});
controller.abort();
console.log((await pending).status); // cancelled
```

### 公共数据类型

```ts
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
  metadata?: Record<string, unknown>;
}
export interface ModelConfig {
  provider?: string;
  model: string;
  endpoint?: string;
  providerOptions?: Record<string, unknown>;
}
export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}
export interface NodeResult<T> {
  executionId: string;
  node: string;
  status: "success" | "failed" | "cancelled" | "timeout";
  output?: T;
  error?: { code: string; message: string };
}
export type ActionTarget =
  | { kind: "tool"; toolName?: string }
  | { kind: "mcp"; server: string; toolName: string }
  | { kind: "node"; node: string };
export interface ActionDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  target?: ActionTarget;
}
export interface ActionRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ContextItem { id?: string; content: unknown; source?: string; score?: number }
export interface MemoryItem { id: string; content: unknown; score?: number; timestamp?: number }
export type Observation = import("@codesoul-co/ditto").Observation;
export interface ReasoningStep {
  id: string;
  type: "plan" | "model" | "decision" | "action_request" | "observation" | "reflection" | "final";
  index: number;
  parentIds?: string[];
  summary?: string;
  message?: Message;
  actionRequest?: ActionRequest;
  observation?: Observation;
}
export type InferStreamEvent<T> =
  | { type: "start"; executionId: string; node: string }
  | { type: "text_delta"; executionId: string; node: string; delta: string }
  | { type: "step"; executionId: string; node: string; step: ReasoningStep }
  | { type: "result"; executionId: string; node: string; result: NodeResult<T> };
export interface InferCallOptions { signal?: AbortSignal; timeoutMs?: number }
```

`Message.content` 支持文本或数组；数组元素由 Provider 解释。OpenAI 适配器将数组作为 Chat Completions 内容块发送。不要在 `metadata` 中携带凭证。`ActionDescriptor.inputSchema` 是提供给模型的 JSON Schema；INFER 校验其为对象，具体动作参数必须由目标 Worker 按自己的公共 Contract 校验。

`GenerationConfig` 校验：`temperature` 为 0–2，`topP` 为 0–1；`topK`、`maxTokens` 为正整数；`seed` 为安全整数；`stop` 为非空字符串数组。未指定的生成参数由 Provider 决定。

## 3. SAMPLE

一次 SAMPLE 只生成一个候选。模型的完整输入配置透传给所选适配器；需要生成多个候选时使用 TRAJECTORY 策略或由 Graph 多次调用。

```ts
export interface SampleInput {
  messages: Message[];
  model: ModelConfig;
  generation?: GenerationConfig;
  actions?: ActionDescriptor[];
  metadata?: Record<string, unknown>;
}
export interface SampleOutput {
  message: Message;
  actionRequests?: ActionRequest[];
  finishReason: "stop" | "length" | "action_request" | "cancelled" | "error";
  usage?: Usage;
}
```

- `messages` 必须非空，`model.model` 必填；动作名称不可重复。
- 返回消息必须是 `assistant`。`finishReason: "action_request"` 必须包含至少一个动作，其他结束原因不能包含动作。
- 每个动作必须由调用方的 `actions` 声明；路由目标只由调用方的 `ActionDescriptor.target` 绑定。SAMPLE 删除 Provider 返回的路由字段，只返回动作，不执行动作。Observation 使用公共 Interaction 接口，不另建 INFER 私有结果类型。
- `length` 作为成功的 SAMPLE 返回，调用者可判断截断；`cancelled` / `error` 转为取消 / 失败的 `NodeResult`。
- Provider usage 必须是非负安全整数；没有 usage 时不伪造计数。

## 4. TRAJECTORY

```ts
export interface TrajectoryInput {
  messages: Message[];
  objective?: string;
  context?: ContextItem[];
  memory?: MemoryItem[];
  strategy: { name: string; options?: Record<string, unknown> };
  model: ModelConfig;
  generation?: GenerationConfig;
  constraints?: { maxSteps?: number; maxTotalTokens?: number; timeoutMs?: number };
  metadata?: Record<string, unknown>;
}
export interface TrajectoryOutput {
  result: Message;
  steps: ReasoningStep[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_tokens" | "timeout" | "cancelled" | "error";
  usage?: Usage;
}
```

### 策略与默认值

以下是未加载配置时的库回退值。应用参数由根目录 `ditto.yaml` 统一配置，当前 YAML 的 ToT/GoT breadth=2；单次请求可覆盖。详见 [统一配置 API](configuration.zh-CN.md)。

| `strategy.name` | `options` | 实际执行方式 |
| --- | --- | --- |
| `cot` | `rounds=2`，1–64 | 一条线性计算路径：简短中间解 → 按原始格式返回最终 Message；rounds=1 为单次 CoT 提示 |
| `long-cot` | `rounds=4`，1–64 | 在线性路径上增加分解、计算与检查阶段，再给出最终 Message |
| `tot` | `breadth=3, depth=2, beamWidth=2`，各 1–16 | 有界广度优先 beam search：展开所有保留状态 → 排序 → 保留前 beamWidth 个；最后一层选一个最终候选 |
| `got` | `breadth=3, depth=2`，各 1–16 | 有界分层图：多个贡献 → 多父节点聚合 → 共享结果供下一层扩展 |
| `self-consistency` | `candidates=3`，1–16 | 独立求解并提取最终答案，按出现频次确定性投票；最高票并列返回 NO_CONSENSUS，不调用额外模型评委 |
| 自定义名称 | 由策略定义 | 使用注入的 `TrajectoryStrategy` |

这些策略是显式的答案组织与修订流程，不暴露模型隐藏思维。`steps` 保存公开的消息、动作、观察和简短决策摘要。ToT / GoT 是有界的分支选择/合并实现，不是通用搜索引擎。扩展策略能力通过策略函数完成，不增加 Node。

### 执行预算

| 约束 | 默认值 | 语义 |
| --- | --- | --- |
| `maxSteps` | 16 | 最多 SAMPLE 次数，包含计划、候选评估与合并中的 SAMPLE；不是 `steps.length` |
| `maxTotalTokens` | 不限 | 累加每次 SAMPLE 的输入和输出 Token；设置后每次模型返回必须提供 `totalTokens` 或完整的 input/output 计数 |
| `timeoutMs` | 无额外时限 | 与调用级 `timeoutMs`（或 Worker 默认时限）取较小值，单位毫秒 |

Token 预算会限制下一次请求的 `generation.maxTokens` 并阻止超预算后的后续调用。输入 Token 在 Provider 返回前未知，因此单次请求仍可能越过预算；它不是付费硬上限。缺少计数时返回 `USAGE_UNAVAILABLE`。Provider 的 `length` 在轨迹中视为 `max_tokens`。

预算耗尽返回外层 `status: "success"`、内层 `status: "partial"`，保留当前结果与推理步骤；模型错误返回外层 `failed`。超时/取消返回相应外层状态，并在已开始轨迹时保留 `output`；尚未产生步骤时内层为 `failed`。

推理主链始终是 `Message[] → Message`：模型配置与策略是执行参数，TRAJECTORY 的 `output.result` 为 assistant Message，可直接加入后续 messages；steps、usage、status 为执行信息。`parentIds` 只引用之前的公开步骤，用来查看线性、树状或聚合依赖，不等同于供应商隐藏推理文本。审议会同时收到原始 messages，避免只比较候选却丢失题目。REFLECT / DELIBERATE 的可选 messages 同样用于携带原始任务。

未加载 YAML 时 ToT（3×2、beamWidth=2）需 11 次 SAMPLE；默认 GoT 需 8 次；独立投票需 candidates 次；所有评估调用都计入 maxSteps。投票会规范化 JSON 键顺序和空白，但不会把不同自然语言答案强行判为同义。CoT/ToT/GoT 是计算组织方式，不保证任何模型对任意问题正确；内容正确性需按任务验收。原始方法参考：[CoT](https://arxiv.org/abs/2201.11903)、[ToT](https://arxiv.org/abs/2305.10601)、[GoT](https://arxiv.org/abs/2308.09687)、[Self-Consistency](https://arxiv.org/abs/2203.11171)。

### Graph 流程与自定义计算策略

ReAct 是 Runtime 的预定义 Graph 流程，通过 `runReactFlow(runtime, input, options?)` 调用；完整接口见 [Runtime 流程](../interaction-runtime.zh-CN.md#react-预定义-graph-流程)。需要规划时先在 Graph 中调用 SAMPLE，再将计划传给 ReAct。检索 Context/Memory 同样由上游 Graph 完成。

```ts
import type { TrajectoryStrategy } from "@codesoul-co/ditto/worker/infer";
const refine: TrajectoryStrategy = async ctx => {
  const draft = await ctx.sample(ctx.messages);
  return (await ctx.sample([...ctx.messages, draft.message,
    { role: "user", content: "Check and refine this answer." }])).message;
};
const customInfer = createInfer({ runtime, strategies: { refine } });
```

策略上下文只有 `input`、组装好的 `messages`、`signal`、`sample(messages, trace?)`、`deliberate(candidates, mode, options?)` 和 `step(...)`；没有 `act` 或 `invoke`。采样和审议共享模型预算。异步工作应配合 `signal`；INFER 能停止等待不配合的 Promise，但不能强制终止任意 JavaScript。

## 5. REFLECT

```ts
export type ReflectionMode = "critique" | "verify" | "revise";
export interface ReflectInput {
  messages?: Message[];
  target: { result?: Message; trajectory?: ReasoningStep[]; artifact?: unknown };
  mode: ReflectionMode;
  criteria?: Array<{ id: string; description: string; weight?: number }>;
  context?: ContextItem[];
  memory?: MemoryItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface ReflectOutput {
  assessment: { passed?: boolean; summary: string };
  issues: Array<{ severity: "info" | "warning" | "error"; description: string; suggestedFix?: string }>;
  revisedResult?: Message;
  usage?: Usage;
}
```

`target` 至少包含 `result`、`trajectory` 或 `artifact`。`criteria.id` 不可重复，`weight` 为非负有限数。所有模式通过 SAMPLE 调用模型，并要求 JSON 对象：

- `critique`：输出 assessment 与 issues。
- `verify`：额外要求 `assessment.passed` 为布尔值。
- `revise`：额外要求 `revisedResult` 为有效 Message。

```ts
const reflected = await infer.reasoning.reflect({
  target: { result: { role: "assistant", content: "候选答案" } },
  mode: "verify", criteria: [{ id: "accuracy", description: "检查事实与结论是否一致", weight: 1 }],
  model: input.model,
});
```

支持纯 JSON 或单个 JSON Markdown 代码块。JSON 格式错误、必填字段缺失、非法严重级别返回 `INVALID_MODEL_OUTPUT`；截断响应返回 `INCOMPLETE_MODEL_OUTPUT`，不会自动猜测结构或重试。usage 始终来自 Provider，不接受生成内容中自报的 usage。

## 6. DELIBERATE

```ts
export interface DeliberateInput {
  messages?: Message[];
  selectCount?: number;
  objective?: string;
  candidates: Array<{ id: string; result: Message; trajectory?: ReasoningStep[]; score?: number }>;
  mode?: "select" | "merge" | "consensus" | "debate";
  context?: ContextItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface DeliberateOutput {
  result: Message;
  selectedCandidateIds?: string[];
  assessments?: Array<{ candidateId: string; score?: number; accepted?: boolean; summary?: string }>;
  decisionSummary?: string;
  usage?: Usage;
}
```

候选数组不能为空，候选 ID 必须唯一。`select` 默认比较并选一个候选，可用 selectCount 指定保留数量；`merge` 合并互补内容；`consensus` 整合共识和不确定性；`debate` 比较反对意见并作出综合判断。每个模式调用一次 SAMPLE，`debate` 不暗含多 Agent 辩论循环。

```ts
const decision = await infer.reasoning.deliberate({
  candidates: [
    { id: "a", result: { role: "assistant", content: "方案 A" } },
    { id: "b", result: { role: "assistant", content: "方案 B" } },
  ], mode: "select", objective: "选择实现成本较低的方案", model: input.model,
});
```

模型返回 JSON，`selectedCandidateIds` / `assessments.candidateId` 只能引用输入 ID，不能重复。`select` 必须恰好选择 selectCount（默认 1）个有序 ID，实际返回排名第一候选的原始 Message，防止模型改写所选结果。其余模式使用模型合成的 Message。输出格式与完整性校验同 REFLECT。当前实现没有额外调用 REFLECT。

根目录 `ditto.yaml` 的 `workers.infer.deliberate` 提供 `mode: select`、`selectCount: 1`、`generation.maxTokens: 4096`。请求可省略 mode 并继承配置，也可显式覆盖。采样按请求 > DELIBERATE 配置 > INFER 通用配置生效。配置中的 selectCount 只应用于 select 模式；超过候选数会在模型调用前失败。ToT/GoT 内部审议保留各自显式模式与轨迹预算。详见 [统一配置 API](configuration.zh-CN.md)。

## 7. CACHE

CACHE 只做显式查询、写入与失效，不自动缓存模型请求、不生成缓存键，也不访问长期 Memory。缓存键建议包含模型、生成配置、动作定义及输入摘要，以避免误复用；调用者负责键和数据版本。

```ts
export interface InferCacheKey {
  namespace?: string;
  scope: "sample" | "trajectory" | "reflection" | "deliberation" | string;
  key: string;
}
```

```ts
export interface CacheLookupInput { key: InferCacheKey }
export interface CacheLookupOutput { hit: boolean; value?: unknown }
```

```ts
export interface CacheWriteInput { key: InferCacheKey; value: unknown; ttlMs?: number; tags?: string[] }
export interface CacheWriteOutput { written: boolean; key: InferCacheKey }
```

```ts
export interface CacheInvalidateInput {
  selector: { type: "key"; key: InferCacheKey } | { type: "tag"; tag: string } | { type: "namespace"; namespace: string };
}
export interface CacheInvalidateOutput { invalidated: number }
```

```ts
const key = { namespace: "tenant-a", scope: "sample", key: "input-version-42" };
await infer.cache.write({ key, value: direct.output, ttlMs: 60_000, tags: ["model-v1"] });
const cached = await infer.cache.lookup({ key });
await infer.cache.invalidate({ selector: { type: "tag", tag: "model-v1" } });
// 也支持 { type: "key", key } 或 { type: "namespace", namespace: "tenant-a" }
```

| 行为 | 默认内存实现 |
| --- | --- |
| 键 | `(namespace ?? "", scope, key)` 三元组，避免字符串拼接碰撞；scope/key 必须非空 |
| TTL | 未提供则不过期；0 表示立即失效；负数/非整数拒绝；到期时 `hit=false` |
| 值 | `structuredClone` 写入和读取，防止引用修改；本地可缓存 `undefined`，命中仍为 true |
| 容量 | 默认最多 1,000 条，可通过构造参数 `maxEntries` 调整；LRU 淘汰 |
| 过期清理 | 查询/按键失效只检查目标；容量不足时和标签/namespace 失效时清理过期项，没有后台 timer |
| 标签 | 精确匹配字符串，覆盖写入会替换旧标签 |
| 失效统计 | 返回实际删除的未过期条数；标签失效跨 namespace |
| 默认 namespace | 省略与空字符串等价 |
| 分布式缓存 | 注入 `InferCacheProvider`；默认内存缓存不跨副本共享，也不持久化 |

远程 Runtime 遵循现有 JSON / Artifact 传输限制，不能依赖函数、循环引用或 `undefined` 等值保持本地语义。共享缓存后端需自行提供一致性与持久化保证。

## 8. 流式事件

```ts
for await (const event of infer.reasoning.trajectory.stream({
  ...input, strategy: { name: "cot" },
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "step") console.log(event.step.type, event.step.index);
  if (event.type === "result") console.log(event.result.status, event.result.output);
}
```

每次订阅按顺序收到 `start`、零个或多个 `text_delta` / `step`、恰好一个 `result`。它们共享同一顶层 `executionId` / `node`。提前 `break` 会取消本次执行，消费者不会再收到终态事件。上游支持 stream 时实时转发增量；只支持 invoke 时，完成后发送一段完整文本，不伪造 token 流。

TRAJECTORY 的 delta 包含中间候选、审议 JSON 和最终回答，不能简单拼接成最终答案；最终答案读取 `result.output.result`。REFLECT / DELIBERATE 的 delta 是待解析 JSON，结构化结果读取终态事件。CACHE 没有 stream 方法。当前 HTTP transport 没有 SSE 流式协议；远程调用仍返回完整 `NodeResult`，如需流式处理，在执行模型的进程中使用 SDK。

## 9. Provider 与缓存后端

模型统一使用 `ModelProvider.invoke/stream`，Runtime 和 INFER 共享 `ProviderRegistry`。内置 OpenAI 兼容、Anthropic 和 Gemini 协议，详细构造参数、注册方式、字段映射、流式与工具往返约定见 [Provider API](providers.zh-CN.md)。

自定义缓存后端契约如下。三个方法均为异步；输入校验、调用超时由 Node 层提供，后端负责存取语义。

```ts
interface InferCacheProvider {
  lookup(input: CacheLookupInput, options?: InferCacheCallOptions): Promise<CacheLookupOutput>;
  write(input: CacheWriteInput, options?: InferCacheCallOptions): Promise<CacheWriteOutput>;
  invalidate(input: CacheInvalidateInput, options?: InferCacheCallOptions): Promise<CacheInvalidateOutput>;
}
```

trace 包含可选 parentIds/summary；sample 和 deliberate 返回额外 stepId，step 返回完整 ReasoningStep。deliberate 的 options 可传 selectCount，仅用于 select。

## 10. 错误

| `error.code` | 含义 |
| --- | --- |
| `INVALID_INPUT` | 输入结构、枚举、范围或调用选项不合法 |
| `UNKNOWN_NODE` / `UNKNOWN_STRATEGY` | 不支持的 Node / 策略 |
| `PROVIDER_NOT_FOUND` | 未配置模型适配器或无法确定默认项 |
| `INVALID_MODEL_OUTPUT` | Provider 消息、动作、usage 或结构化 JSON 不合法 |
| `INCOMPLETE_MODEL_OUTPUT` | REFLECT / DELIBERATE 被截断，或 SSE 提前断开 |
| `UNDECLARED_ACTION` | SAMPLE 请求了未声明的动作 |
| `USAGE_UNAVAILABLE` | 指定 Token 预算，但 Provider 缺少必要计数 |
| `ENDPOINT_MISMATCH` / `PROVIDER_HTTP_ERROR` | 模型端点不匹配 / HTTP 请求失败 |
| `MODEL_ERROR` | Provider 显式返回 error（包括 content_filter） |
| `TIMEOUT` / `CANCELLED` | 总时限到期 / 调用被取消 |
| `EXECUTION_FAILED` | 其他执行错误（如自定义适配器抛错、Sandbox 拒绝、不可克隆的缓存值） |

Node 内的错误转为 `NodeResult`；构造阶段的错误直接抛出。Runtime 在路由前失败（无可用 Worker、Runtime 已关闭、HTTP 认证失败等）仍使用现有 Runtime 的异常语义，不会凭空产生 INFER NodeResult。

## 逐 API 使用示例

完整代码：[examples/infer.ts](examples/infer.ts)。下列函数共用该文件的 imports；函数不会在导入时自动执行。数据库、模型和 MCP 参数由应用注入，不是 Ditto 内置的模拟后端。选择需要的函数调用；写入、删除、模型调用等会产生对应的真实操作。

```ts
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import {
  createInfer, createInferWorker, InMemoryInferCache, inferSampleNode,
  type InferClient, type ModelConfig, type TrajectoryInput, type ReflectInput,
  type DeliberateInput, type TrajectoryStrategy, type InferCacheProvider, type ModelProvider, type SampleInput,
} from "@codesoul-co/ditto/worker/infer";

import { ProviderRegistry, createHttpProvider, type HttpProviderOptions } from "@codesoul-co/ditto/worker/infer/providers";
```

导出类型应优先从 `@codesoul-co/ditto/worker/infer` 获取，避免与 Core 的 Message / MemoryItem 同名类型混淆。INFER Message.content 是文本或 Provider 内容数组；Interaction Message.content 允许更广的 JSON。

### createInfer / createInferWorker：共享配置与缓存

创建 Runtime 后，SDK 可复用它的 services；注入同一个 cache 才会共享缓存。两种调用都不会自动把模型结果写入缓存。Worker 的 cacheFactory 可按副本创建资源，优先于 cache。

```ts
export function setupInfer() {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const cache = new InMemoryInferCache({ maxEntries: 2_000 });
  const runtime = createDitto({ config, workers: [createInferWorker({ cache, concurrency: 4 })] });
  const infer = createInfer({ runtime, cache });
  return { runtime, infer }; // runtime.close() drains Workers; the application owns external clients.
}
```

### reasoning.sample / SAMPLE：消息输入与输出

返回 assistant Message、finishReason、可选 usage。示例消费真实结果而不预设模型必然回答正确；finishReason=length 表示截断。

```ts
export async function sample(infer: InferClient, model: ModelConfig) {
  const result = await infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Return the sum of 17 and 25." }],
    generation: { temperature: 0, maxTokens: 256 },
  });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return { message: result.output.message, finishReason: result.output.finishReason, usage: result.output.usage };
}
```

### SAMPLE actions：只生成动作请求

输入动作描述，输出 actionRequests。目标工具名由应用绑定；后续交给 Graph/ReAct 执行。actions 不是工具实现，不会在 SAMPLE 内自动执行。

```ts
export async function sampleActions(infer: InferClient, model: ModelConfig) {
  return infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Read README.md using the available tool." }],
    actions: [{ name: "read_text", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      target: { kind: "tool", toolName: "read_text" } }],
  }); // Inspect output.actionRequests; SAMPLE does not execute them.
}
```

### reasoning.trajectory / TRAJECTORY：完整结果判定

同时检查外层 NodeResult.status 和内层 output.status。外层 success 可能仍是预算耗尽后的 partial；只将 completed 作为完整结果使用。

```ts
export async function trajectory(infer: InferClient, model: ModelConfig) {
  const result = await infer.reasoning.trajectory({ model,
    messages: [{ role: "user", content: "Compare two ways to batch database writes." }],
    strategy: { name: "cot", options: { rounds: 2 } },
    constraints: { maxSteps: 4, timeoutMs: 30_000 },
  });
  if (result.status !== "success" || result.output?.status !== "completed") {
    throw new Error(result.error?.code ?? result.output?.stopReason ?? result.status);
  }
  return result.output.result;
}
```

### CoT、Long CoT、ToT、GoT、Self-consistency 示例

下面五个请求逐一对应五种内置策略；每个都是合法的 TRAJECTORY 输入。通过 `await infer.reasoning.trajectory(strategyRequests(model)[0]!)` 选择一个执行，不需要为策略额外创建 Worker。

```ts
export function strategyRequests(model: ModelConfig): TrajectoryInput[] {
  const messages: TrajectoryInput["messages"] = [{ role: "user", content: "Find the cheapest valid delivery route." }];
  return [
    { model, messages, strategy: { name: "cot", options: { rounds: 2 } } },
    { model, messages, strategy: { name: "long-cot", options: { rounds: 4 } } },
    { model, messages, strategy: { name: "tot", options: { breadth: 2, depth: 2, beamWidth: 2 } }, constraints: { maxSteps: 16 } },
    { model, messages, strategy: { name: "got", options: { breadth: 2, depth: 2 } }, constraints: { maxSteps: 16 } },
    { model, messages, strategy: { name: "self-consistency", options: { candidates: 3 } }, constraints: { maxSteps: 3 } },
  ]; // Run any one with infer.reasoning.trajectory(request).
}
```

### reasoning.reflect / REFLECT：三种模式

分别调用 `reflectModes(infer, model, "critique")`、`"verify"`、`"revise"`。三者共有 assessment/issues；verify 必须给出 passed，revise 必须给出 revisedResult。JSON 不合法时返回失败，不猜测或补造结果。

```ts
export async function reflectModes(infer: InferClient, model: ModelConfig, mode: ReflectInput["mode"]) {
  const result = await infer.reasoning.reflect({ model, mode,
    messages: [{ role: "user", content: "What is 2 + 2?" }],
    target: { result: { role: "assistant", content: "5" } },
    criteria: [{ id: "arithmetic", description: "The result must equal 4.", weight: 1 }],
  });
  // mode = "critique": assessment + issues; "verify": assessment.passed; "revise": revisedResult.
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output;
}
```

### reasoning.deliberate / DELIBERATE：四种模式

分别传 select、merge、consensus、debate。selectCount 仅在 select 模式传入，且不能超过候选数。select 的 output.result 是排名第一候选的原始 Message；其余模式是合成 Message。

```ts
export async function deliberateModes(infer: InferClient, model: ModelConfig, mode: NonNullable<DeliberateInput["mode"]>) {
  const result = await infer.reasoning.deliberate({ model, mode,
    objective: "Prefer a design with bounded memory and clear error handling.",
    candidates: [
      { id: "a", result: { role: "assistant", content: "Use bounded batches with explicit failures." } },
      { id: "b", result: { role: "assistant", content: "Buffer all records and retry indefinitely." } },
    ],
    ...(mode === "select" ? { selectCount: 1 } : {}),
  }); // mode: select / merge / consensus / debate.
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return { message: result.output.result, ids: result.output.selectedCandidateIds, assessments: result.output.assessments };
}
```

### cache.write / lookup / invalidate：全部缓存操作

三个方法及按 key/tag/namespace 失效都有对应调用。lookup.output.hit=false 是成功的未命中，不是失败；需先判断 NodeResult.status。tag 失效会跨 namespace。

```ts
export async function cacheApis(infer: InferClient) {
  const key = { namespace: "tenant-a", scope: "sample", key: "model-and-input-hash:v1" };
  const written = await infer.cache.write({ key, value: { role: "assistant", content: "42" }, ttlMs: 60_000, tags: ["model-v1"] });
  const lookup = await infer.cache.lookup({ key });
  if (lookup.status === "success" && lookup.output?.hit) console.log(lookup.output.value);
  const byKey = await infer.cache.invalidate({ selector: { type: "key", key } });
  const byTag = await infer.cache.invalidate({ selector: { type: "tag", tag: "model-v1" } });
  const byNamespace = await infer.cache.invalidate({ selector: { type: "namespace", namespace: "tenant-a" } });
  return { written, lookup, byKey, byTag, byNamespace };
}
```

### infer.execute：动态 Node 调用

与 reasoning.sample 等便捷方法返回同一种 NodeResult；仅支持七个 INFER 叶子。第二个重载支持显式 `<Input, Output>` 泛型，但不会绕过运行时校验。

```ts
export async function executeInfer(infer: InferClient, model: ModelConfig) {
  return infer.execute("INFER.REASONING.SAMPLE", { model, messages: [{ role: "user", content: "Hello" }] }, { timeoutMs: 5_000 });
}
```

### sample.stream / trajectory.stream / reflect.stream / deliberate.stream

四个流式方法分别给出调用与对应终态字段。流式方法也支持第二参数 `{ signal, timeoutMs }`。为了便于对照，下例顺序消费四个流；实际应用通常选择其中一个。text_delta 不等同于最终结构化输出。

```ts
export async function streamApis(infer: InferClient, model: ModelConfig) {
  const sampleInput = { model, messages: [{ role: "user" as const, content: "Give a brief answer." }] };
  const trajectoryInput: TrajectoryInput = { ...sampleInput, strategy: { name: "cot" } };
  const reflectInput: ReflectInput = { model, mode: "verify", target: { result: { role: "assistant", content: "2 + 2 = 4" } } };
  const deliberateInput: DeliberateInput = { model, mode: "select", candidates: [{ id: "a", result: { role: "assistant", content: "4" } }] };
  // Each method has its own typed terminal output; consume one selected stream in production.
  for await (const event of infer.reasoning.sample.stream(sampleInput)) {
    if (event.type === "result") console.log(event.result.output?.message);
  }
  for await (const event of infer.reasoning.trajectory.stream(trajectoryInput)) {
    if (event.type === "step") console.log(event.step.id, event.step.parentIds);
    if (event.type === "result") console.log(event.result.output?.result);
  }
  for await (const event of infer.reasoning.reflect.stream(reflectInput)) {
    if (event.type === "result") console.log(event.result.output?.assessment);
  }
  for await (const event of infer.reasoning.deliberate.stream(deliberateInput)) {
    if (event.type === "result") console.log(event.result.output?.selectedCandidateIds);
  }
}
```

### InferCallOptions：取消与调用时限

示例使用已取消的信号，返回 cancelled 且不会发起模型请求。运行中取消通过同一 controller.abort() 发起；SDK 停止等待不代表第三方服务已撤销操作。

```ts
export async function cancelInfer(infer: InferClient, model: ModelConfig) {
  const controller = new AbortController();
  controller.abort();
  return infer.reasoning.sample({ model, messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal, timeoutMs: 5_000 });
}
```

### InMemoryInferCache / InferCacheProvider 原始接口

构造参数为 `{ maxEntries?: number, now?: () => number }`；默认 1000 条、Date.now。now 是毫秒时钟，便于确定性验证。三个底层方法直接返回原始输出；SDK/Worker 才提供输入校验、截止时间及 NodeResult。

```ts
export async function cacheProviderApi(cache: InferCacheProvider = new InMemoryInferCache({ maxEntries: 100 })) {
  const key = { scope: "sample", key: "example" };
  await cache.write({ key, value: "cached message", ttlMs: 1_000 });
  const hit = await cache.lookup({ key }); // Raw CacheLookupOutput, not NodeResult.
  const invalidated = await cache.invalidate({ selector: { type: "key", key } });
  return { hit, invalidated };
}
```

### TrajectoryStrategy：sample / deliberate / step

示例覆盖三个计算方法及 signal；sample/deliberate 返回 stepId，可用于 parentIds。`step` 只登记公开轨迹，不执行模型。策略计算仍消耗当前轨迹预算，不能调用工具或调度其他 Worker。

```ts
export const refineStrategy: TrajectoryStrategy = async ctx => {
  ctx.signal.throwIfAborted();
  const draft = await ctx.sample(ctx.messages, { summary: "Create a draft" });
  const revised = await ctx.sample([...ctx.messages, draft.message, { role: "user", content: "Correct mistakes and return the final answer." }], { parentIds: [draft.stepId] });
  const decision = await ctx.deliberate([
    { id: "draft", result: draft.message }, { id: "revised", result: revised.message },
  ], "select", { selectCount: 1, parentIds: [draft.stepId, revised.stepId] });
  ctx.step({ type: "decision", parentIds: [decision.stepId], summary: "Selected a checked answer" });
  return decision.result;
};
// createInfer({ runtime, strategies: { refine: refineStrategy } });
// infer.reasoning.trajectory({ model, messages, strategy: { name: "refine" } });
```

### 节点描述符 type / define

`inferSampleNode`、`inferTrajectoryNode`、`inferReflectNode`、`inferDeliberateNode` 分别提供对应 Node 的 `.type` 和 `.define(workerType, handler)`。普通应用使用 createInferWorker 即可；下面示例把已有 SDK 方法绑定成单个 NodeDefinition。缓存三个叶子由工厂注册；`INFER_CACHE_NAMESPACE` 只是值为 INFER.CACHE 的命名空间常量，不能作为 Node 调用。

```ts
export function sampleDescriptor(infer: InferClient) {
  return inferSampleNode.define("INFER", input => infer.reasoning.sample(input));
}
```

## 与 CONTEXT 组合

通过 CONTEXT.SELECT 选取后显式映射成 messages。INFER 使用自身的消息与 ContextItem 契约；工作上下文的 source 是 Reference，传入 INFER 的 source 时需取 uri。 [完整 CONTEXT API 与调用示例](context.zh-CN.md)。

```ts
export async function contextToInfer(context: WorkingContext, infer: InferClient, model: ModelConfig) {
  const selected = await createContext().select({ context, purpose: "infer", limit: 16 });
  return infer.reasoning.sample({ model, messages: [
    ...selected.context.items.map(item => ({ role: "user" as const,
      content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
    })),
    { role: "user", content: "Explain the evidence." },
  ] });
}
```

[完整 imports 和代码](examples/context.ts)。

## Runtime 取消

`runtime.invoke(node, input, { signal })`、`runtime.run(graph, input, { signal })` 的取消信号经内置 INFER Worker 传入执行器和模型 Provider，与直接 SDK 的取消选项一致。Provider 应使用其 HTTP/SDK 的取消机制。例如：

```ts
await runtime.invoke("INFER.REASONING.SAMPLE", {
  model: { provider: "openai", model: "configured-model" },
  messages: [{ role: "user", content: "Explain caching" }],
}, { signal: AbortSignal.timeout(5000) });
```

跨机器 HTTP 或同机 IPC 的信号当前只控制调用方等待，不自动中断远端执行；服务端仍应配置模型超时。

外部 `InferCacheProvider.lookup/write/invalidate(input, options?)` 的第二参数为 `InferCacheCallOptions { signal?: AbortSignal }`。例如 `lookup: (input, options) => databaseCache.lookup(input, options)`，由适配器按底层 SDK 约定继续传递取消；INFER 超时停止等待，不会撤销数据库已提交的缓存写入。

[内容处理完整流程](content-workflows.zh-CN.md) 组合 SAMPLE 生成与独立复核、Redis Context、数据库 Memory 及校验后的文件发布。
