# CONTEXT Worker API

[English](context.md) · **简体中文** · [Worker API](README.zh-CN.md)

CONTEXT 管理当前任务的工作上下文：LOAD 归一化输入，UPDATE 合并内容，SELECT 为推理或长期记忆选取内容，COMPRESS 控制预算。它支持显式 Context 计算，以及按 scope 读写临时缓存。缓存默认适配 Redis，客户端由应用创建并注入；也可通过 ContextStateStore 替换后端。`createContext()` 不建立连接；只有 scope 调用访问已配置的缓存。长期记录与数据库操作仍由 MEMORY 负责。

## 功能选择与参数影响

| Node | 适合的任务 | 关键参数与状态变化 |
| --- | --- | --- |
| `CONTEXT.LOAD` | 初始化消息、Skill、资料与引用，或恢复工作集 | `sources` 提供内容；`resolveReferences` 控制引用解析。scope 加 sources 初始化/替换缓存；只有 scope 时读取已有状态 |
| `CONTEXT.SELECT` | 为当前推理选择证据，或为长期记忆选择可复用信息 | `purpose`、`query`、`strategy`、`limit`、`maxTokens` 控制本次投影，不修改原工作集或 scope 缓存 |
| `CONTEXT.UPDATE` | 加入结果、替换同 ID 内容、删除失效资料 | 按 `removeIds` → `add` → `ingress` 合并；scoped 模式通过 CAS 保存新工作集 |
| `CONTEXT.COMPRESS` | 将历史工作集限制在预算内 | `maxItems`、`maxTokens` 和 metadata 决定裁剪；默认删除条目组，scoped 模式保存结果 |

### 参数怎样改变信息覆盖

| 参数 / 设计 | 行为影响 | 取舍与边界 |
| --- | --- | --- |
| SELECT `limit` / COMPRESS `maxItems` | 较大值允许更多条目进入结果 | 增加下游输入量；条数不是 token 数，一条长文也可能占满预算 |
| SELECT / COMPRESS `maxTokens` | 较大值容纳更多估算 token；较小值更容易舍弃资料 | 是 Context 内容预算，不包含完整模型协议、额外提示和输出，需为它们预留窗口；SELECT 跳过装不下的条目 |
| SELECT `purpose:"infer"` | 默认优先 system、protected、currentGoal | 优先排序不等于保证保留，SELECT 仍可因预算跳过它们；推理前检查必要指令是否入选 |
| SELECT `purpose:"memory"` | 默认优先 memoryCandidate、reusable、stable，排除 private=true / memoryEligible=false | 只选择候选，不写入 MEMORY；这些规则不是所有用途通用的权限过滤器 |
| SELECT `query` / `strategy` | default 使用当前快照的词项重合等评分；rag / provider 使用注入服务 | 词项重合不等于语义相似；中文分词、向量检索或外部知识库需配置适配器，可能增加网络/embedding 调用 |
| metadata `priority` / `relevance` | 调整默认选择与压缩的保留优先级 | 是应用数值，不是校准置信度；过大的优先级可能压过相关性信号 |
| metadata `protected` / `safety` / `currentGoal` / `pending` / role=system | COMPRESS 保留这些条目 | 保护内容超预算时失败；压缩保护与 SELECT 排序不同 |
| metadata `callId` | COMPRESS 将同一工具调用的相关条目作为一组 | 整组保留或移除，避免请求和结果断开；大保护组可能导致 BUDGET_UNSATISFIABLE |
| LOAD `resolveReferences:true` | 通过 resolver 解析裸 Reference，保留来源身份 | 默认 false；增加 I/O、内容和耗时，应用 resolver 应限制访问范围、大小和权限 |
| UPDATE ID / policy.duplicate | 同 ID 可 replace、keep-first 或 reject；新 ID 继续增加条目 | replace 保留原插入位置；使用稳定 ID 可避免每轮堆积重复资料 |

请求 `limit`、`maxItems`、`maxTokens` 允许 0–1000000，0 是零预算；policy 数值为正整数并作为上限。默认 maxItems=256、maxInlineBytes=65536、maxTokens 未设置。提高 policy 不扩大模型窗口或 Redis 容量；LOAD / UPDATE 超条数上限会失败，不自动 COMPRESS。

默认 tokenEstimator 使用 JSON UTF-8 字节数 / 4 向上取整，不是具体模型 tokenizer。不同语言、图片和协议的真实计数可能不同；需要准确预算时注入 estimator，并记录真实 usage。默认压缩删除条目组；语义摘要需要显式 INFER → 校验 → UPDATE → COMPRESS，并另行评估模型成本与信息损失。

### scope 与 Worker 资源

显式 `context` 计算快照，`scope` 访问注入 Redis / stateStore，二者互斥。sessionId、turnId、invocationId 一起决定缓存键；每轮改变 turnId 会产生不同工作集。需要共享会话时使用一致的受控 scope；多 Agent 可以把角色纳入 sessionId，但 scope 本身不是认证凭证。

`expectedVersion` 在版本变化或过期时失败，避免旧状态覆盖新状态。更长 Redis TTL 提高缓存可用时间，也延长资料保留；长期任务仍需 Memory。Context policy/services 从构造参数接入，读取 YAML 后需显式传入；请求预算只能收紧 policy 上限。

Worker `concurrency` 控制入口调用数；同 scope 写入还受 CAS 和 operationQueue 影响。配置的本地队列按 scope 串行，默认 maxPending=1024；扩大队列容纳更多等待操作，也增加内存和等待时间，不加速单个 scope。共享状态的本地副本应共享适当 store/queue；本地队列不能代替跨进程并发控制。

### 参数取舍实例

RAG 检索出 20 条资料，SELECT `limit:8,maxTokens:3000` 最多保留 8 条并满足估算预算。将 limit 改成 20，仍可能只容纳少量长条目。检查 selectedItemIds、必要证据和真实输入用量，再决定扩展预算、切分资料或改变排序。输入变短可以降低成本，也可能丢掉唯一关键证据。

## 接入与配置

从 `@codesoul-co/ditto/worker/context` 或根入口导入工厂。共用数据类型 Context、ContextItem、Message、Reference 从 `@codesoul-co/ditto/contracts` 导入。`createContext(options?)` 创建直接 SDK；`createContextWorker(options?)` 注册四个同名节点。两者共用实现，返回 Context 或 ContextSelection，失败抛出 ContextError；不返回 NodeResult。

| 选项 | 默认 / 行为 |
| --- | --- |
| policy.maxInlineBytes | 65536；单项 content 的 JSON UTF-8 字节上限，引用项允许超出 |
| policy.maxItems | 256；LOAD/UPDATE 最终条数，SELECT/COMPRESS 上限 |
| policy.maxTokens | 未设置；仅约束 SELECT/COMPRESS，不自动压缩 LOAD/UPDATE |
| policy.duplicate | replace；也支持 keep-first、reject。替换保留原插入位置 |
| policy.missingRemoval | ignore；reject 时删除不存在 ID 抛错 |
| services | 注入估算器、选择器、压缩器、RAG、stateStore、operationQueue |
| redis | `{ client, ttlMs?, keyPrefix? }`；不能与 services.stateStore 同时传入 |
| servicesFactory | 仅 Worker；每个本地副本创建一次 services，优先于 services |
| concurrency | 仅 Worker；正整数，默认不限制顶层调用并发 |

根目录 YAML 的 `workers.context.policy` 放上述策略，`workers.context.cache` 放 ttlMs、keyPrefix；加载结果为 `config.context`，创建 SDK/Worker 时显式传入。Redis 地址和凭据由应用从 `.env` 的 `DITTO_WORKER_CONTEXT_REDIS_URL` 读取并交给 SDK；Ditto 的配置加载器不建立 Redis 连接，也不隐式读取 `.env`。客户端连接与关闭归应用负责，Runtime.close() 不关闭注入的 Redis。

## 数据格式与四个节点

```ts
interface ContextItem {
  id: string;
  content: MessageContent; // JSON 值、文本或消息内容块
  source?: Reference;     // { uri, mediaType?, digest? }
  metadata?: JsonObject;
}
interface Context { items: readonly ContextItem[] }
interface ContextSelection {
  purpose: "infer" | "memory";
  context: Context;
  selectedItemIds: readonly string[];
}
```

| SDK / Node | 输入 | 输出与行为 |
| --- | --- | --- |
| load / CONTEXT.LOAD | `{ sources: (Message \| Reference \| ContextItem)[], resolveReferences?: boolean }` | Context；Message/Reference 用规范化内容生成稳定 ID；Message.role/name 放 metadata；Reference 默认保持引用，resolveReferences=true 时解析内容 |
| update / CONTEXT.UPDATE | `{ context, removeIds?, add?, ingress? }` | Context；依次删除、添加、接收跨 Worker ingress；ingress 含 id/sourceNode/content/reference?/metadata?，sourceNode 写入 metadata |
| select / CONTEXT.SELECT | `{ context, purpose, query?, limit?, maxTokens?, strategy? }` | ContextSelection；按顺序去重、限制条数和预算；不写缓存、Memory 或模型 |
| compress / CONTEXT.COMPRESS | `{ context, maxItems?, maxTokens? }` | Context；默认按组删减，不调用模型生成摘要 |
| execute | `execute(node, input, options?)` | 四个叶子的通用调用入口；按节点推导输入/返回类型 |

输出是独立、深度冻结的快照。条目 ID 非空，重复输入 Context ID 无效，内容必须是有限、无循环的 JSON。请求 limit/maxItems/maxTokens 可为 0，最大 1000000；policy 数值必须为正整数且不超过 1000000。请求不能放宽 policy 限制。

SELECT 默认策略为 `{ kind: "default" }`。infer 优先 system/protected/currentGoal，memory 优先 memoryCandidate/reusable/stable 并排除 private=true 或 memoryEligible=false；其余权重来自 priority、relevance、查询词重合和位置。预算不足时跳过放不下的项。SELECT 是选取而非安全策略，受保护内容也可能因预算被跳过。未注入 tokenEstimator 时按 JSON UTF-8 字节数 / 4 向上估算，非模型精确 token 数。

COMPRESS 保护 metadata 中 protected/safety/currentGoal/pending=true 或 role=system 的条目，相同非空 callId 的条目作为不可拆分的组。优先删除低 priority/relevance、可再次检索及较早的组，保留顺序。受保护组超预算抛 BUDGET_UNSATISFIABLE；不静默删除。没有 token 预算时不进行 token 估算。自定义 compressor 不能引入新 ID、删除保护项或拆散 callId 组，最终内容仍受条数、inline 和 token 限制。

## 可选缓存模式

缓存请求传入 `scope: { sessionId?, turnId?, invocationId? }`，至少一个非空标识。字段组合共同确定一个 key；仅 sessionId 可跨 turn 共享，增加 turnId 则隔离每轮。不自动从 Runtime 的单次请求 ID 派生会话，不执行层级回退。应用验证 scope 的归属与权限，租户前缀可编码进 sessionId；scope 不是访问凭证。

| 操作 | 缓存行为 |
| --- | --- |
| LOAD `{ scope, sources }` | 创建或整体替换该 scope；sources=[] 显式清空内容 |
| LOAD `{ scope }` | 读取完整缓存；缺失/过期抛 CONTEXT_NOT_FOUND |
| UPDATE `{ scope, add?, ingress?, removeIds? }` | 读取完整缓存、计算增量并按读到的版本提交 |
| SELECT `{ scope, purpose, ... }` | 读取后选取，不写回、不延长 TTL |
| COMPRESS `{ scope, ... }` | 读取、压缩、按版本写回 |

缓存请求不能同时传 context；除初始化 LOAD 外，缺失缓存不会自动创建。可选 expectedVersion 对读到的版本做额外检查。一次修改最多一次读取和一次原子 CAS，无自动重试；跨副本冲突抛 STATE_CONFLICT，由应用重新读取后决定是否重试。SDK 返回值仍是 Context/ContextSelection，需要版本时使用 stateStore.get()。业务动作不应随冲突盲目重放。

Redis 默认 keyPrefix=`ditto:context:`、ttlMs=3600000。key 后缀是标识元组的 SHA-256；一个 scope 一个 JSON 字符串，版本使用随机 UUID。写入成功时重设 TTL，读取不续期；Redis 重启、过期或淘汰均可能使临时状态消失。CAS 使用单 key 的 Lua 脚本检查版本并 SET PX，适配 Redis Cluster 的单 key 路由，不需要分布式锁或后台定时器。[Redis EVAL](https://redis.io/docs/latest/commands/eval/)。

### 存储插件接口

```ts
interface ContextStateStore {
  get(scope: ContextScope, options?: ContextCallOptions): Promise<StoredContext | undefined>;
  compareAndSet(scope: ContextScope, expectedVersion: string | undefined, next: Context, options?: ContextCallOptions): Promise<StoredContext>;
}
interface StoredContext { version: string; context: Context }
interface RedisContextClient {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
```

`compareAndSet(..., undefined, ...)` 只创建缺失记录；指定版本必须与现存版本一致，否则抛 STATE_CONFLICT。外部插件必须原子实现版本比较和写入，新版本不能复用以免过期后发生 ABA。`createRedisContextStore(client, options?)` 可单独调用；node-redis 的已连接 client 直接符合接口，其他 SDK 可用 get/eval 两个转发函数适配。

可选 `ContextOperationQueue.enqueue(scope, operation, options?)` 包裹缓存请求。可注入自有队列，或使用 `createContextOperationQueue()` 创建有容量上限的进程内串行队列。跨进程一致性仍依赖存储 CAS。

## 选择、RAG 与压缩插件

| 服务 / 工厂 | 调用约定 |
| --- | --- |
| tokenEstimator.estimate(content) | 返回非负安全整数或 Promise；没有预算时跳过 |
| selector.select(input) | `{ kind: "provider", name, options? }` 路由到该服务；服务自行识别 name，返回 ContextItem[] |
| ragStrategy.select(input) | `{ kind: "rag", corpus?: Reference, options? }`；query 为 MessageContent |
| createRagStrategy({ embed?, retrieve, rank? }) | 内部按可选 embed → 必需 retrieve → 可选 rank 调用，再按 item.id 保留首项；不是额外节点 |
| embed.embed({ query?, items, corpus?, options? }) | 任意 embedding 结果传给 retrieve |
| retrieve.retrieve({ query?, items, corpus?, options?, embedding? }) | 返回 `{ item: ContextItem, score?, metadata? }[]` |
| rank.rank({ query?, items, corpus?, options?, candidates }) | 返回候选数组，顺序就是选择优先级 |
| compressor.compress(input) | 返回符合相同 ID、保护项、关联组和预算规则的 Context |
| referenceResolver.resolve(reference) | LOAD 设置 resolveReferences=true 时调用；默认只保存引用 |

RAG 的 candidate.score/metadata 不自动合并到 item.metadata；如需后续默认选择使用分数，适配器显式写入 relevance。SELECT 只返回选取视图；想持久加入工作集时显式 UPDATE。普通检索直接复用数据库/Provider；高计算量可在 retrieve 中委托独立 RETRIEVAL，先检查 NodeResult，再映射完整 ContextItem。MEMORY 查询结果和检索候选的 content 是 unknown，适配器应明确转换成 JSON/文本。

`defaultSelect(input)`、`deterministicCompress(input, execution)`、`isProtectedContextItem(item)` 可供自定义策略复用。`createContextExecution(policy?, services?)` 解析并冻结策略；直接使用底层策略函数不会执行 SDK 的整套输入/输出校验。

节点描述符 `contextLoadNode`、`contextSelectNode`、`contextUpdateNode`、`contextCompressNode` 提供 `.type` 和 `.define(workerType, handler)`；定义不会自动注册 Worker。底层 `loadNode/selectNode/updateNode/compressNode(input, execution)` 接收显式输入与 ContextExecution，缓存路由由 createContext/createContextWorker 提供。通常优先使用工厂，底层函数适合自定义 Worker 复用。

## Graph 与其他 Worker

- MEMORY.SEARCH → 检查 NodeResult → 显式映射 → CONTEXT.UPDATE；长期写入由 CONTEXT.SELECT purpose=memory 后交给 MEMORY.WRITE 的 Graph 实现。
- CONTEXT.SELECT purpose=infer → messages 映射 → INFER；INFER 的 ContextItem 类型与工作 ContextItem 不同，不能直接假定 source 等字段相同。
- INTERACTION.ACT.TOOL/MCP → OBSERVE → CONTEXT.UPDATE；缓存模式下可在 Graph 的 UPDATE 绑定中传 scope。
- `runRagFlow(runtime, { context, query?, corpus?, limit?, maxTokens?, options? })` 调用 SELECT 的 rag 策略，返回 `{ output: ContextSelection, context }`。
- `runSkillFlow(runtime, { sources, context? })` LOAD 已解析的 Skill 内容；提供 context 时再 UPDATE，返回 `{ output: Context, context }`。Skill 文件/权限解析由应用负责。

这两个 Runtime helper 接收显式 Context；缓存 Graph 可直接调用四个节点。Worker 保持四个能力，工具与模型不进入 CONTEXT 的默认执行流程。

## 错误与调用示例

| code | 含义 |
| --- | --- |
| INVALID_INPUT / UNKNOWN_NODE | 输入或节点无效 |
| INLINE_LIMIT_EXCEEDED / ITEM_LIMIT_EXCEEDED | 内容或条数超限 |
| DUPLICATE_ITEM / MISSING_ITEM | 策略拒绝重复或删除缺失项 |
| STRATEGY_UNAVAILABLE | 未配置或不支持选择策略 |
| INVALID_PROVIDER_OUTPUT | 选择、压缩或估算服务返回值无效 |
| BUDGET_UNSATISFIABLE | 保护项无法容纳 |
| STATE_STORE_UNAVAILABLE / CONTEXT_NOT_FOUND | 未配置缓存或状态缺失 |
| STATE_CONFLICT / INVALID_STATE | 写入冲突或存储数据损坏 |

ContextError 的 code/message 可用于应用分支；Redis SDK、用户服务、Runtime 路由和传输异常也可能原样拒绝 Promise。没有后台重试或把异常包装成成功的空 Context。

完整可调用代码见 [examples/context.ts](examples/context.ts)，所有函数共享下方 imports；函数不会在导入时执行。Redis SDK 安装及连接方式见[示例指南](examples/guide.zh-CN.md#context--redis)。

```ts
import {
  createContext, createContextWorker, createRedisContextStore, createContextExecution,
  createRagStrategy, contextLoadNode, ContextError, contextScopeKey,
  defaultSelect, deterministicCompress, isProtectedContextItem,
  type ContextStateStore, type RedisContextClient,
  type ContextServices, type ContextOptions, type ContextCompressor,
} from "@codesoul-co/ditto/worker/context";
import { createDitto, graph, loadRuntimeConfigFile, runRagFlow, runSkillFlow } from "@codesoul-co/ditto";
import type { Context as WorkingContext, ContextItem as WorkingItem } from "@codesoul-co/ditto/contracts";
import type { InferClient, ModelConfig } from "@codesoul-co/ditto/worker/infer";
import { createMemoryWorker, type MemoryResources } from "@codesoul-co/ditto/worker/memory";
import type { RetrievalSearchProvider, RetrievalTarget } from "@codesoul-co/ditto-retrieval";
```

### 创建 SDK 与 Worker

```ts
export function setupContext(client: RedisContextClient) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const settings: ContextOptions = {
    ...(config.context.policy === undefined ? {} : { policy: config.context.policy }),
    redis: { client, ...config.context.cache },
  };
  return {
    context: createContext(settings),
    runtime: createDitto({ config, workers: [createContextWorker({ ...settings, concurrency: 16 })] }),
  };
}
```

### LOAD：消息、条目与引用

```ts
export async function loadContext() {
  return createContext().load({ sources: [
    { role: "system", content: "Answer using the supplied evidence." },
    { id: "goal", content: "Explain the API", metadata: { currentGoal: true } },
    { uri: "file:///workspace/api.md", mediaType: "text/markdown" },
  ] });
}
```

### SELECT：推理与记忆用途

```ts
export async function selectContext(context: WorkingContext) {
  const client = createContext();
  const infer = await client.select({ context, purpose: "infer", query: "API", limit: 8, maxTokens: 2048 });
  const memory = await client.select({ context, purpose: "memory", limit: 4 });
  return { infer, memory }; // { purpose, context, selectedItemIds }, not NodeResult.
}
```

### UPDATE：增量与来源

```ts
export async function updateContext(context: WorkingContext) {
  return createContext().update({ context, removeIds: ["old"],
    add: [{ id: "goal", content: "Explain the cache", metadata: { currentGoal: true } }],
    ingress: [{ id: "observation:call-1", sourceNode: "INTERACTION.OBSERVE", content: "file contents",
      metadata: { callId: "call-1", status: "success" } }],
  });
}
```

### COMPRESS：预算

```ts
export async function compressContext(context: WorkingContext) {
  return createContext().compress({ context, maxItems: 32, maxTokens: 4096 });
}
```

### execute：通用调用

```ts
export async function executeContext() {
  return createContext().execute("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] });
}
```

### 四个节点的缓存调用

```ts
export async function cachedContext(store: ContextStateStore) {
  const client = createContext({ services: { stateStore: store } });
  const scope = { sessionId: "tenant-a:session-1", turnId: "turn-1" };
  await client.load({ scope, sources: [{ id: "goal", content: "Review API" }] });
  await client.update({ scope, add: [{ id: "evidence", content: "Relevant source" }] });
  const selected = await client.select({ scope, purpose: "infer", limit: 1 });
  await client.compress({ scope, maxItems: 16 });
  const full = await client.load({ scope });
  return { selected, full }; // SELECT does not persist its projection.
}
```

### Redis 存储与显式版本

```ts
export async function redisStore(client: RedisContextClient) {
  const store = createRedisContextStore(client, { ttlMs: 60000, keyPrefix: "app:context:" });
  const scope = { sessionId: "session-2" };
  const before = await store.get(scope);
  const written = await store.compareAndSet(scope, before?.version, { items: [{ id: "a", content: "one" }] });
  // A stale version rejects with STATE_CONFLICT; the application decides whether to retry.
  const context = createContext({ services: { stateStore: store } });
  await context.update({ scope, expectedVersion: written.version, add: [{ id: "b", content: "two" }] });
  return { key: contextScopeKey(scope), latest: await store.get(scope) };
}
```

### 注入自定义服务

```ts
export function contextServices(compressor: ContextCompressor): ContextServices {
  return {
    tokenEstimator: { estimate: content => Math.ceil(JSON.stringify(content).length / 4) },
    selector: { async select(input) {
      if (input.strategy?.kind !== "provider" || input.strategy.name !== "latest") {
        throw new ContextError("STRATEGY_UNAVAILABLE", "Unknown selector");
      }
      return [...input.context.items].reverse();
    } },
    compressor,
  };
}
```

### RAG 策略

```ts
export async function ragContext(context: WorkingContext, search: (query: unknown) => Promise<readonly WorkingItem[]>) {
  const ragStrategy = createRagStrategy({
    retrieve: { async retrieve(input) { return (await search(input.query)).map(item => ({ item })); } },
  });
  return createContext({ services: { ragStrategy } }).select({
    context, purpose: "infer", query: "API", strategy: { kind: "rag" }, limit: 5,
  });
}
```

### 复用 RETRIEVAL Provider

```ts
export function contextRetrieval(provider: RetrievalSearchProvider, target: RetrievalTarget) {
  return createRagStrategy({ retrieve: { async retrieve(input) {
    const output = await provider.search({ query: { content: input.query ?? "" }, target, limit: 10 });
    return output.candidates.map(candidate => {
      const id = candidate.id ?? candidate.source?.ref;
      if (!id) throw new Error("Map retrieval candidates to stable Context IDs");
      return { item: {
      id,
      content: typeof candidate.content === "string" ? candidate.content : JSON.stringify(candidate.content),
      metadata: { ...(candidate.score === undefined ? {} : { relevance: candidate.score }) },
    } };
    });
  } } });
}
```

### 传入 INFER

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

### MEMORY 与 Context Graph

```ts
export async function memoryToContext(resources: MemoryResources) {
  const runtime = createDitto({ workers: [createMemoryWorker(resources), createContextWorker()] });
  const plan = graph<string>("memory-context")
    .node("search", "MEMORY.SEARCH", [], query => ({ query, limit: 5 }))
    .node("context", "CONTEXT.UPDATE", ["search"], (_query, { search }) => {
      if (search.status !== "success" || !search.output) throw new Error(search.error?.code ?? search.status);
      return { context: { items: [] }, ingress: search.output.map(hit => ({
        id: `memory:${hit.memory.id}`, sourceNode: "MEMORY.SEARCH" as const,
        content: typeof hit.memory.content === "string" ? hit.memory.content : JSON.stringify(hit.memory.content),
        metadata: { memoryId: hit.memory.id, ...(hit.score === undefined ? {} : { relevance: hit.score }) },
      })) };
    });
  try { return await runtime.run(plan, "language preference"); }
  finally { await runtime.close(); }
}
```

### RAG 与 Skill 流程

```ts
export async function contextFlows(services: ContextServices) {
  const runtime = createDitto({ workers: [createContextWorker({ services })] });
  try {
    const skill = await runSkillFlow(runtime, { sources: [{ id: "review-skill", content: "Check correctness." }] });
    return await runRagFlow(runtime, { context: skill.context, query: "API", limit: 5 });
  } finally { await runtime.close(); }
}
```

### 错误分支

```ts
export async function contextErrors() {
  try { await createContext().load({ scope: { sessionId: "one" } }); }
  catch (error) {
    if (error instanceof ContextError) return error.code; // STATE_STORE_UNAVAILABLE
    throw error;
  }
}
```

### 复用内置策略

```ts
export async function directStrategies(context: WorkingContext) {
  const execution = createContextExecution({ maxItems: 16 });
  const ordered = await defaultSelect({ context, purpose: "infer" });
  const compressed = await deterministicCompress({ context, maxItems: 8 }, execution);
  return { ordered, compressed, protectedIds: context.items.filter(isProtectedContextItem).map(item => item.id) };
}
```

### 自定义节点描述符

```ts
export const customContextLoad = contextLoadNode.define("CONTEXT", async input => createContext().load(input));
```

### 写入长期 MEMORY

```ts
export async function contextToMemory(context: WorkingContext, memory: ReturnType<typeof import("@codesoul-co/ditto/worker/memory").createMemory>) {
  const selected = await createContext().select({ context, purpose: "memory", limit: 8 });
  return memory.write({ memories: selected.context.items.map(item => ({
    content: item.content, metadata: { contextItemId: item.id },
  })) });
}
```

### 工具观察写入缓存

```ts
export async function toolToCachedContext(
  runtime: import("@codesoul-co/ditto").RuntimeClient,
  scope: import("@codesoul-co/ditto/worker/context").ContextScope,
  call: import("@codesoul-co/ditto/contracts").ToolCall,
) {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call });
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result });
  // The application chooses whether failed observations should enter its working set.
  if (observation.status !== "success") throw new Error(observation.error?.code ?? observation.status);
  return runtime.invoke("CONTEXT.UPDATE", { scope, ingress: [{
    id: `observation:${call.id}`, sourceNode: "INTERACTION.OBSERVE", content: observation.message.content,
    metadata: { callId: call.id, source: observation.source, status: observation.status },
  }] });
}
```

### 委托独立 RETRIEVAL

```ts
export function remoteContextRetrieval(runtime: import("@codesoul-co/ditto").RuntimeClient, target: RetrievalTarget) {
  return contextRetrieval({ async search(input) {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", input);
    if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
    return result.output;
  } }, target);
}
```

可直接运行的数据库接入示例：[examples/worker](examples/integrations/README.zh-CN.md)，包含 SDK 安装、env 配置、调用及资源清理。

## 本地缓存、队列与引用加载

`createInMemoryContextStore({ ttlMs?, maxEntries?, now? })` 实现与 Redis 相同的 get/CAS 接口，默认 TTL 3600000 ms、最多 1000 个 scope。ttlMs 范围 1–2147483647，maxEntries 为正安全整数；now 可注入毫秒时钟。读取更新 LRU 次序但不延长 TTL，写入刷新 TTL；容量不足时清理过期项，再淘汰最久未使用项。返回不可变快照，无连接和后台定时器，进程结束后数据消失。

`createContextOperationQueue({ maxPending? })` 默认最多 1024 个等待中/运行中操作。同 scope 串行，不同 scope 独立执行；达到总容量时抛 QUEUE_FULL，失败后释放容量且不阻塞后续操作。入队和开始执行时检查取消；已取消的等待项仍占容量直到前面的任务结束。共享状态的本地副本应共享同一 store/queue 实例。它不是分布式锁。

`load({ sources, resolveReferences: true })` 按输入顺序调用 `services.referenceResolver.resolve(reference, options?)` 解析单独的 Reference。开关默认 false，启用时必须提供 sources 和 resolver；Message/ContextItem 不额外解析。结果保留原稳定 ID 和 source URI，必须是有限、无环 JSON，并满足 maxInlineBytes。缺少服务、无效内容、超限分别抛 RESOLVER_UNAVAILABLE、INVALID_PROVIDER_OUTPUT、INLINE_LIMIT_EXCEEDED。URI 授权和有界 I/O 由 resolver 实现，Core 不默认开放任何协议或网络权限。

```ts
import { createContext, createInMemoryContextStore, createContextOperationQueue,
  loadRuntimeConfigFile } from "@codesoul-co/ditto";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const store = createInMemoryContextStore(config.context.localCache);
const queue = createContextOperationQueue(config.context.queue);
const context = createContext({ services: {
  stateStore: store, operationQueue: queue,
  referenceResolver: { async resolve(reference, options) {
    options?.signal?.throwIfAborted();
    if (reference.uri !== "urn:goal") throw new Error("Unknown reference");
    return "Explain the retrieval pipeline";
  } },
} });
const scope = { sessionId: "example" };
await context.load({ scope, sources: [{ uri: "urn:goal" }], resolveReferences: true });
await Promise.all(["a", "b"].map(id => context.update({ scope, add: [{ id, content: id }] })));
const selected = await context.select({ scope, purpose: "infer", limit: 2 },
  { signal: AbortSignal.timeout(5000) });
const snapshot = await store.get(scope);
if (snapshot) await store.compareAndSet(scope, snapshot.version, snapshot.context);
await queue.enqueue(scope, async () => "application operation");
```

所有 SDK 方法在 input 后接受可选 `ContextCallOptions`；execute 是第三个参数。signal 传递至 selector、RAG 各阶段、compressor、tokenEstimator、referenceResolver、stateStore 和 operationQueue；各端口在原参数之后接收 options，compareAndSet 为第四个参数。SDK 取消时 reject，持久化前取消不会提交 CAS，但无法撤回外部已完成的写入。Runtime Worker 自动提供当前 signal 和绑定本次执行的 runtime 以委托其他 Worker；应用通常只需设置 signal。

数据库检索可以直接复用 [Context 检索适配器](retrieval-providers.zh-CN.md#context-检索适配器)，完整可运行代码见 [SQLite 示例](examples/integrations/context-retrieval.ts)。

[完整上下文任务示例](context-workflows.zh-CN.md) 展示公开 Runtime 组装、语义摘要、持久化检查点和 npm 消费端验收。
