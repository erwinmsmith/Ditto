# MEMORY Worker API

[English](memory.md) · [Worker API](README.zh-CN.md)

MEMORY 提供长期记忆的六个访问原语：GET、QUERY、SEARCH、WRITE、UPDATE、DELETE。Ditto 实现节点路由、输入/输出校验、结果封装和插件注入；数据库驱动、连接池、表/collection、索引和迁移由应用或外部插件管理。Core 不安装或启动 MySQL、PostgreSQL、Milvus，也不包含 SQL 或 Milvus 客户端。

## 接入方式

```ts
import { createDitto, createMemory, createMemoryWorker, loadRuntimeConfigFile } from "@ditto/core";
import type { MemoryResources } from "@ditto/core/worker/memory";

// resources 来自应用自己的数据库适配包，Ditto 不负责构造或关闭它们。
function startMemory(resources: MemoryResources) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const runtime = createDitto({
    config,
    workers: [createMemoryWorker({ ...resources, concurrency: 16 })],
  });
  const sdk = createMemory({ ...resources, defaults: config.memory });
  return { runtime, sdk };
}
```

`createMemory(options)` 提供 `execute(node, input)` 以及 `get/query/search/write/update/delete(input)`。它与 `runtime.invoke(node, input)` 返回同一种 `NodeResult`。`createMemoryWorker(options)` 注册全部六个节点，支持已有 Graph、`ctx.invoke` 和 HTTP transport。

`MemoryOptions` 是 `{ store, search, defaults?, concurrency? }`。`concurrency` 只限制 Runtime Worker 的并发入口；直接 SDK 不调度并发。`defaults` 为 `{ queryLimit?, searchLimit? }`。

## 两个独立插件接口

```ts
interface MemoryStore {
  get(input: MemoryGetInput): Promise<MemoryGetOutput>;
  query(input: MemoryQueryInput): Promise<MemoryQueryOutput>;
  write(input: MemoryWriteInput): Promise<MemoryWriteOutput>;
  update(input: MemoryUpdateInput): Promise<MemoryUpdateOutput>;
  delete(input: MemoryDeleteInput): Promise<MemoryDeleteOutput>;
}
interface MemorySearchProvider {
  search(input: MemorySearchInput): Promise<MemorySearchOutput>;
}
interface MemoryResources {
  readonly store: MemoryStore;
  readonly search: MemorySearchProvider;
}
```

| 外部接入方式 | store | search |
| --- | --- | --- |
| MySQL / PostgreSQL | 关系型适配插件 | 该插件支持的全文/向量搜索，或独立搜索插件 |
| 独立 Milvus | Milvus 插件，负责完整记录的读写和结构化查询 | 同一个 Milvus 插件 |
| 混合部署 | 任意 MemoryStore | 任意 MemorySearchProvider |

同一个对象实现两个接口时，使用 `createMemoryWorker({ store: backend, search: backend })`。Milvus 不要求附加 SQL 存储。拆分部署时，SEARCH 返回完整 `MemoryItem`，搜索插件自行解决索引与事实数据的映射、一致性和权限，Ditto 不自动执行第二次 SQL GET。

端口只要求上述方法，无基类、注册中心或数据库枚举。插件实现者负责数据库方言/表达式、参数化查询、序列化、namespace/tenant 隔离、事务、版本冲突、超时和资源生命周期。复用 Worker definition 会复用注入的插件对象；需要隔离连接或租户时，分别创建插件和 Worker definition。关闭 Runtime 会等待已接受调用结束，但不会关闭应用拥有的插件连接。

## 公共数据与返回

```ts
interface MemoryItem {
  id: string;
  key?: string;
  content: unknown;
  metadata?: Record<string, unknown>;
}
interface MemoryDraft {
  key?: string;
  content: unknown;
  metadata?: Record<string, unknown>;
}
interface MemorySearchResult {
  memory: MemoryItem;
  score?: number;
  metadata?: Record<string, unknown>;
}
interface NodeResult<T> {
  executionId: string;
  node: string;
  status: "success" | "failed" | "cancelled" | "timeout";
  output?: T;
  error?: { code: string; message: string };
}
```

`NodeResult` 来自共享 `@ditto/core/contracts`，与 INFER 共用。插件方法返回下面列出的原始 Output，节点仅包装一次。MEMORY 当前返回 `success` 或 `failed`；未增加独立取消/超时机制，也不会因调用超时假定数据库已回滚。底层超时由插件控制。

`content` 不被强制转成 Message、字符串或向量。进程内 SDK 可以使用应用自己的对象；跨 HTTP 或持久化时，应由应用/插件约定可序列化格式。metadata 中的租户、版本等保留字段由插件定义。id/key 必须是非空字符串。搜索 score 如提供必须为有限数值，其量纲和排序方向由插件定义，Ditto 不重新排序搜索结果。

## 六个节点

| Node ID | 原始 Output | 依赖 |
| --- | --- | --- |
| MEMORY.GET | `readonly MemoryItem[]` | store.get |
| MEMORY.QUERY | `{ items: readonly MemoryItem[]; nextCursor?: string }` | store.query |
| MEMORY.SEARCH | `readonly MemorySearchResult[]` | search.search |
| MEMORY.WRITE | `readonly MemoryItem[]` | store.write |
| MEMORY.UPDATE | `readonly MemoryItem[]` | store.update |
| MEMORY.DELETE | `{ deleted: readonly string[] }` | store.delete |

### GET

```ts
interface MemoryGetInput { ids?: readonly string[]; keys?: readonly string[]; }
const result = await runtime.invoke("MEMORY.GET", { ids: ["m1"], keys: ["preference"] });
```

至少提供 ids/keys 中的一种；可同时提供，两者取并集。Ditto 去重输入，忽略未返回的记录，并按请求 ids 顺序、再按 keys 顺序输出，同一记录只输出一次。两组都为空时直接返回 `[]`，不调用插件。插件应保证同一作用域内 key 唯一；不同 id 返回相同 key 违反插件契约。GET 不执行相关性搜索。

### QUERY

```ts
interface MemoryQueryInput {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
}
const result = await runtime.invoke("MEMORY.QUERY", {
  filter: { tenant: "project-a", state: "active" },
  orderBy: [{ field: "createdAt", direction: "desc" }],
  limit: 20,
});
```

结构化、确定性的查询。filter DSL、支持字段、默认排序和 cursor 编码由插件约定；Ditto 原样透传，不把对象解释成 SQL 或 Milvus 表达式。cursor 必须为非空字符串，作为不透明分页 token 处理。插件应保证稳定排序，末页省略 nextCursor，返回数量不得超过 limit。不支持的 filter/orderBy 应明确失败，不能静默忽略。切换后端时，应用需同步适配其查询语义。

### SEARCH

```ts
interface MemorySearchInput {
  query: unknown;
  strategy?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  options?: Record<string, unknown>;
}
const result = await runtime.invoke("MEMORY.SEARCH", {
  query: { vector: [0.1, 0.2, 0.3] },
  strategy: "vector",
  filter: { tenant: "project-a" },
  limit: 10,
  options: { metric: "COSINE" },
});
```

query 字段必须存在，具体值由插件校验。示例字段仅表示应用与其插件的约定，并非 Ditto 内置 Milvus 参数。vector、keyword、bm25、hybrid、graph 等均可作为策略名；未知策略由插件明确拒绝。Ditto 不内置 embedding，不固定执行 EMBED → RETRIEVE → RANK，不要求 Retrieval Worker。搜索结果需要包含完整 memory、可选 score 和检索 metadata；保持插件返回顺序。

### WRITE

```ts
interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
const result = await runtime.invoke("MEMORY.WRITE", {
  memories: [{ key: "preference", content: { language: "zh-CN" }, metadata: { source: "user" } }],
});
```

创建记录，id 由插件分配；空数组直接返回 `[]`。插件必须在事实存储提交后才返回成功，并为每条输入返回一个完整 MemoryItem。key 冲突策略由插件明确声明，不能因冲突静默丢弃一条输入。Ditto 不自动生成 id，不隐式调用模型、embedding、Consolidation 或 Context。

### UPDATE

```ts
interface MemoryUpdateEntry {
  id: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
}
interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
const result = await runtime.invoke("MEMORY.UPDATE", {
  memories: [{ id: "m1", metadata: { source: "corrected" } }],
});
```

固定为字段级 partial update：省略 content 或 metadata 保留原字段；提供 metadata 替换整个 metadata 对象，`{}` 清空 metadata。content 使用属性是否存在来判断更新，`null` 是合法内容。不能修改 id/key；目标不存在时插件必须失败，不能 upsert。重复 id、无更新字段或提供 key 会在进入插件前失败。空数组直接返回 `[]`。成功输出必须包含所有请求 id 各一次，保留完整记录和原 key。插件负责冲突检测与并发一致性；Ditto 不预读记录、不追加版本协议、不触发 re-embedding Workflow。

### DELETE

```ts
interface MemoryDeleteInput { ids: readonly string[]; }
interface MemoryDeleteOutput { deleted: readonly string[]; }
const result = await runtime.invoke("MEMORY.DELETE", { ids: ["m1", "m1"] });
```

Ditto 去重 ids，空数组直接返回 `{ deleted: [] }`。插件应忽略不存在的 id，仅返回本次实际删除的 id，不重复、不包含未请求 id；再次删除同一 id 返回空数组。软/硬删除由插件决定，删除后不得在通常读取中返回记录。淘汰选择、自动过期和降权策略由用户 Graph/Policy 管理。

## 校验和错误

所有 limit 必须是 1–10000 的整数。数组、必填属性、非空标识、metadata/filter/options 对象和 orderBy 方向均在调用插件前校验。输出校验包括记录形状、重复 id、有限 score、分页 token、结果数量、更新 id 集合及删除 id 范围。

| code | 含义 |
| --- | --- |
| INVALID_INPUT | 请求违反公共契约，插件未被调用 |
| UNKNOWN_NODE | 直接 SDK execute 收到未知节点 |
| INVALID_BACKEND_OUTPUT | 插件返回内容违反契约；已完成的写入不会因此回滚 |
| MEMORY_BACKEND_ERROR | 未分类的插件异常；不会把原始数据库错误或连接凭据返回调用者 |
| 插件自定义 code | 插件抛出 `new MemoryError(code, safeMessage)`，例如 NOT_FOUND / CONFLICT / UNSUPPORTED_STRATEGY |

`MemoryError` 的 message 是公开错误，插件只能放可安全暴露的信息。批量事务保证由插件声明；若后端不能原子处理批量变更，插件应明确其部分提交语义。Ditto 不提供自动重试、事务补偿或“失败意味着未提交”的保证。Graph bind 应检查 `result.status` 后再消费 output。

## 配置

```yaml
workers:
  memory:
    queryLimit: 100
    searchLimit: 10
```

根目录 ditto.yaml 管理行为默认值，加载后位于 `config.memory`。逐字段优先级：请求 limit > `MemoryOptions.defaults` > Runtime YAML > 内置 QUERY 100 / SEARCH 10。直接 SDK 通过 `defaults: config.memory` 显式接入 YAML。配置在创建时形成快照，不逐请求读取文件。

数据库 URL、凭据和连接配置由外部插件读取 env；Ditto 不增加无消费者的数据库环境变量或 YAML 占位项。应用若统一管理插件 env，可沿用 `DITTO_WORKER_MEMORY_<PLUGIN>_*` 分组，但这些不是 Core 解析的变量。

## 与 Graph / Context 的边界

MEMORY 不调用其他 Core Worker，不负责 RAG、反思、合并、淘汰调度或 Skill 管理。`runRagFlow({ scope: "memory", ... })` 是 Runtime 的组合函数，执行 SEARCH → 用户映射 → CONTEXT.UPDATE；搜索失败时不更新 Context。content 是 unknown，因此需要调用者显式提供映射：

```ts
import { runRagFlow } from "@ditto/core/runtime";
const result = await runRagFlow(runtime, {
  scope: "memory", context: { items: [] }, query: "user preferences",
  mapMemory: ({ memory, score }) => ({
    id: `memory:${memory.id}`, sourceNode: "MEMORY.SEARCH",
    content: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    metadata: { memoryId: memory.id, ...(score === undefined ? {} : { score }) },
  }),
});
```

映射需符合应用数据类型和 Context 的 JSON 契约，上例适用于 JSON 内容。Skill 由应用解析，`runSkillFlow({ context, skill })` 激活 CONTEXT.SKILL；轻量 SkillRegistry 已移到 context 目录，根导出保持可用。

## 旧接口迁移与验证范围

旧 MEMORY.RETRIEVE 拆成 GET / QUERY；MEMORY.RAG.* 改为 SEARCH；CONSOLIDATE 和 EVICT 改为用户 Graph/Policy 组合；MEMORY.SKILL 移出 MEMORY。旧 MemoryItem.message 改为 content；Runtime 输出改为共享 NodeResult。旧 scaffold 文件已删除，不保留失效别名。

`npm run check` 包含注入插件的 CRUD、独立/混合资源、透传、校验、配置、失败隔离及真实本地 HTTP transport 测试。测试插件只用于验证 Ditto 契约，不代表真实 MySQL/PostgreSQL/Milvus 驱动测试；具体数据库插件应在自己的仓库验证持久化、查询语义、事务和索引一致性。

## 可选独立 Retrieval 服务

普通 MemorySearchProvider 保持不变。需要独立检索资源时，可显式导入 `@ditto/core/worker/retrieval/adapters/memory` 的 RemoteRetrievalSearchProvider，配置固定 target 与按需的批量 mapOutput，将 MEMORY.SEARCH 委托给 RETRIEVAL.SEARCH。调用方契约不变；MEMORY 不直接依赖或自动启动该扩展。见 [接入和部署说明](retrieval.zh-CN.md)。

同一存储插件/连接也可以提供原生检索。可选 createMemoryRetrievalProvider 将现有原生 search 接入 RETRIEVAL；createRetrievalMemorySearchProvider 则让 MEMORY 在进程内直接复用 embedding/搜索/融合/重排链路，无需启动另一个 Worker。候选包含完整 MemoryItem 时，远程转接可省略 mapOutput。见[数据库与 embedding 接线](retrieval-providers.zh-CN.md)。SEARCH 的 embedding 不会让 WRITE 自动构建或同步向量索引。
