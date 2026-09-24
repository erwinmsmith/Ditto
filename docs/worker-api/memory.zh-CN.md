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

`createMemory(options)` 提供 `execute(node, input, options?)` 以及 `get/query/search/write/update/delete(input, options?)`。它与 `runtime.invoke(node, input)` 返回同一种 `NodeResult`。`createMemoryWorker(options)` 注册全部六个节点，支持已有 Graph、`ctx.invoke` 和 HTTP transport。

`MemoryOptions` 是 `{ store, search?, defaults?, concurrency? }`。`concurrency` 只限制 Runtime Worker 的并发入口；直接 SDK 不调度并发。`defaults` 为 `{ queryLimit?, searchLimit? }`。

## 两个独立插件接口

```ts
interface MemoryStore {
  get(input: MemoryGetInput, options?: MemoryCallOptions): Promise<MemoryGetOutput>;
  query(input: MemoryQueryInput, options?: MemoryCallOptions): Promise<MemoryQueryOutput>;
  write(input: MemoryWriteInput, options?: MemoryCallOptions): Promise<MemoryWriteOutput>;
  update(input: MemoryUpdateInput, options?: MemoryCallOptions): Promise<MemoryUpdateOutput>;
  delete(input: MemoryDeleteInput, options?: MemoryCallOptions): Promise<MemoryDeleteOutput>;
}
interface MemorySearchProvider {
  search(input: MemorySearchInput, options?: MemoryCallOptions): Promise<MemorySearchOutput>;
}
interface MemoryResources {
  readonly store: MemoryStore & Partial<MemorySearchProvider>;
  readonly search?: MemorySearchProvider;
}
```

| 外部接入方式 | store | search |
| --- | --- | --- |
| MySQL / PostgreSQL | 关系型适配插件 | 该插件支持的全文/向量搜索，或独立搜索插件 |
| 独立 Milvus | Milvus 插件，负责完整记录的读写和结构化查询 | 同一个 Milvus 插件 |
| 混合部署 | 任意 MemoryStore | 任意 MemorySearchProvider |

默认使用 store 自带的原生 search：同一数据库插件实现两个接口时，只需 `createMemoryWorker({ store: backend })`。显式传入 search 才替换检索执行方，CRUD 仍使用原 store。仅有 CRUD 的插件也可接入，无需提供空 search；调用 SEARCH 时返回 SEARCH_UNAVAILABLE。Milvus 不要求附加 SQL 存储。拆分部署时，SEARCH 返回完整 `MemoryItem`，搜索插件自行解决索引与事实数据的映射、一致性和权限，Ditto 不自动执行第二次 SQL GET。

端口只要求上述方法，无基类、注册中心或数据库枚举。插件实现者负责数据库方言/表达式、参数化查询、序列化、namespace/tenant 隔离、事务、版本冲突、超时和资源生命周期。复用 Worker definition 会复用注入的插件对象；需要隔离连接或租户时，分别创建插件和 Worker definition。关闭 Runtime 会等待已接受调用结束，但不会关闭应用拥有的插件连接。


### Embedding 与独立执行

MEMORY 统一常见数据库访问契约，实际操作由数据库插件调用相应 SDK。它不是 ORM，也不复制数据库的查询引擎。原生全文、向量、图或其它检索方法都可以由同一插件的 search 执行。

| 场景 | 执行方式 |
| --- | --- |
| 数据库内置 embedding/检索 | `createMemoryWorker({ store: database })`，数据库 SDK 接收原始文本；不再重复调用外部 embedding。 |
| 数据库需要外部向量 | 插件注入云端或本地 EmbeddingProvider，生成向量后调用数据库 SDK；也可复用可选模块的 vector Provider。 |
| 独立的检索系统或本地计算链路 | 显式注入 `search`，CRUD 与检索可以分别连接不同后端。 |
| 需要独立 CPU/GPU、并发容量或部署 | 将同一底层检索链路注册到 RETRIEVAL，MEMORY 的 search 改用 RemoteRetrievalSearchProvider。 |

“计算在哪执行”与“数据存在哪”相互独立；数据库在云端也不要求启动 RETRIEVAL，使用本地模型也不要求新增 Worker。云 SDK、本地模型 SDK 都可以直接实现 Provider；HTTP 是其中一种接入方式。详细示例见[云端与本地 Provider](retrieval-providers.zh-CN.md#云端与本地-provider)。

对于写入侧 embedding，数据库内置函数可在 SDK 写入时完成；需要外部 embedding 时，由存储插件的 write/update 实现显式调用 Provider，并处理向量与记录的一致性。MEMORY 不会在每个 WRITE 上强加一次模型调用。只有元数据更新时是否需要重算、如何批处理和维护索引，仍由了解实际 schema 的插件决定。

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
| SEARCH_UNAVAILABLE | 未提供独立 search，且数据库插件没有原生 search；CRUD 仍可用 |
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

MEMORY.SEARCH 返回 NodeResult，Graph 检查成功后将 unknown content 显式映射到 CONTEXT.UPDATE 的 ingress。CONTEXT.LOAD/UPDATE 接收已由应用解析的 Skill 内容；长期记忆不管理 Skill。缓存模式可把 UPDATE 的 context 换成 scope。

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

[完整 CONTEXT API](context.zh-CN.md)

## 可选独立 Retrieval 服务

普通 MemorySearchProvider 保持不变。需要独立检索资源时，可显式导入 `@ditto/core/worker/retrieval/adapters/memory` 的 RemoteRetrievalSearchProvider，配置固定 target 与按需的批量 mapOutput，将 MEMORY.SEARCH 委托给 RETRIEVAL.SEARCH。调用方契约不变；MEMORY 不直接依赖或自动启动该扩展。见 [接入和部署说明](retrieval.zh-CN.md)。

同一存储插件/连接也可以提供原生检索。可选 createMemoryRetrievalProvider 将现有原生 search 接入 RETRIEVAL；createRetrievalMemorySearchProvider 则让 MEMORY 在进程内直接复用 embedding/搜索/融合/重排链路，无需启动另一个 Worker。候选包含完整 MemoryItem 时，远程转接可省略 mapOutput。见[数据库与 embedding 接线](retrieval-providers.zh-CN.md)。SEARCH 的 embedding 不会让 WRITE 自动构建或同步向量索引。

## 逐 API 使用示例

完整代码：[examples/memory.ts](examples/memory.ts)。下列函数共用该文件的 imports；函数不会在导入时自动执行。数据库、模型和 MCP 参数由应用注入，不是 Ditto 内置的模拟后端。选择需要的函数调用；写入、删除、模型调用等会产生对应的真实操作。

```ts
import { createDitto, graph, loadRuntimeConfigFile } from "@ditto/core";
import {
  createMemory, createMemoryWorker, MemoryError, memoryGetNode,
  type MemoryResources, type MemoryStore, type MemorySearchProvider,
} from "@ditto/core/worker/memory";
```

### createMemory / createMemoryWorker：初始化

两种工厂都接收 MemoryOptions。SDK 直接调用插件；Worker 参与 Runtime 路由。默认 search 来自 store.search，显式 search 会覆盖它。两者不自动关闭数据库连接。

```ts
export function setupMemory(resources: MemoryResources) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const worker = createMemoryWorker({ ...resources, concurrency: 16 });
  const runtime = createDitto({ config, workers: [worker] });
  const memory = createMemory({ ...resources, defaults: config.memory });
  return { runtime, memory };
}
```

### memory.get / MEMORY.GET：精确读取

成功 output 是 MemoryItem 数组，例如 `[{ id: "m1", key: "preference", content: { language: "zh-CN" } }]`；记录不存在时省略该记录。下面演示去重输入和安全取 output。

```ts
export async function getMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.get({ ids: ["m1", "m1"], keys: ["preference"] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(item => ({ id: item.id, content: item.content }));
}
```

### memory.query / MEMORY.QUERY：分页

成功 output 为 `{ items: [...], nextCursor?: string }`。再次查询时保留同一 filter、orderBy 与作用域，只替换 cursor。示例取前两页；支持的排序字段由插件决定。

```ts
export async function queryMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const first = await memory.query({ limit: 20, orderBy: [{ field: "id", direction: "asc" }] });
  if (first.status !== "success" || !first.output) throw new Error(first.error?.code ?? first.status);
  const items = [...first.output.items];
  if (first.output.nextCursor) {
    const next = await memory.query({ limit: 20, orderBy: [{ field: "id", direction: "asc" }], cursor: first.output.nextCursor });
    if (next.status !== "success" || !next.output) throw new Error(next.error?.code ?? next.status);
    items.push(...next.output.items);
  }
  return items;
}
```

### memory.search / MEMORY.SEARCH：相关性检索

成功 output 为 `[{ memory: { id, content, ... }, score?, metadata? }]`。示例使用插件默认策略；需要指定 vector/keyword 时，应先确认该插件支持。

```ts
export async function searchMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.search({ query: "preferred language", limit: 5 });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(hit => ({ id: hit.memory.id, content: hit.memory.content, score: hit.score }));
}
```

### memory.write / MEMORY.WRITE：创建

示例创建 preference，返回数据库分配的 id。完整输出记录数必须与输入相同。重复 key、事务和幂等策略由插件声明；重复运行示例可能冲突。

```ts
export async function writeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.write({ memories: [{ key: "preference", content: { language: "zh-CN" }, metadata: { source: "user" } }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!.id; // Allocated by the storage plugin.
}
```

### memory.update / MEMORY.UPDATE：部分更新

将 WRITE 返回的 id 传入。本例替换 content，并用空对象清空 metadata。只改 metadata 时省略 content；缺失字段不更新，不能通过 UPDATE 修改 key。

```ts
export async function updateMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.update({ memories: [{ id, content: { language: "en" }, metadata: {} }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!; // metadata is replaced, not merged; key is unchanged.
}
```

### memory.delete / MEMORY.DELETE：删除

返回 `{ deleted: ["m1"] }` 或 `{ deleted: [] }`。不要用“没有抛异常”判断实际删除数量，应检查 output.deleted。

```ts
export async function deleteMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.delete({ ids: [id, id] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.deleted; // A missing id is not reported as deleted.
}
```

### memory.execute：统一 SDK 入口

签名为 `execute<N extends MemoryNode>(node, input, defaults?: MemoryDefaults)`；第三参数作为默认值后备层，优先级低于工厂 defaults，通常使用工厂 defaults 即可。六个便捷方法使用相同执行器。

```ts
export async function executeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  return memory.execute("MEMORY.QUERY", { limit: 10 });
}
```

### MemoryStore / MemorySearchProvider：适配接口

适配层直接返回原始 Output，不再套 NodeResult。此例演示保留 SDK 方法的 this 绑定；传入的 database 已是符合 Memory 契约的应用适配对象，不是原生 SQL/Milvus SDK。原生 SDK 的字段转换、参数化查询和事务应在该对象内部实现。

```ts
export function adaptDatabase(database: MemoryStore & Partial<MemorySearchProvider>): MemoryResources {
  // These methods are the application's SDK adapter, not raw SQL/Milvus SDK methods.
  // Explicit calls retain the SDK adapter's receiver and connection pool.
  const store: MemoryStore = {
    get: (input, options) => database.get(input, options),
    query: (input, options) => database.query(input, options),
    write: (input, options) => database.write(input, options),
    update: (input, options) => database.update(input, options),
    delete: (input, options) => database.delete(input, options),
  };
  const search = database.search ? { search: (input: Parameters<MemorySearchProvider["search"]>[0], options?: Parameters<MemorySearchProvider["search"]>[1]) => database.search!(input, options) } : undefined;
  return { store, ...(search ? { search } : {}) };
}
```

### MemoryError 与失败消费

公开错误使用 `new MemoryError(code, safeMessage)`。默认查询参数不合法会在调用插件前返回 INVALID_INPUT；未知后端异常统一转为 MEMORY_BACKEND_ERROR。失败输出不能当作空结果继续消费。

```ts
export async function memoryErrors(store: MemoryStore) {
  const search: MemorySearchProvider = {
    async search(input) {
      if (input.strategy !== "keyword") throw new MemoryError("UNSUPPORTED_STRATEGY", "Only keyword search is supported");
      throw new MemoryError("SEARCH_UNAVAILABLE", "Search is temporarily unavailable");
    },
  };
  const memory = createMemory({ store, search });
  const invalid = await memory.query({ limit: 0 }); // failed / INVALID_INPUT; store.query is not called.
  const unavailable = await memory.search({ query: "x", strategy: "keyword" });
  return { invalid, unavailable };
}
```

### Graph 与关闭顺序

也可将 MEMORY 节点放到用户 Graph 中。Runtime.close 排空已接受调用后，再由应用关闭数据库连接。后续 INFER 应通过 Graph bind 显式映射 MemoryItem.content。

```ts
export async function memoryGraph(resources: MemoryResources) {
  const runtime = createDitto({ workers: [createMemoryWorker(resources)] });
  const plan = graph<string>("read-memory")
    .node("memory", "MEMORY.GET", [], id => ({ ids: [id] }));
  try { return await runtime.run(plan, "m1"); }
  finally { await runtime.close(); } // Close the application's database pool afterwards.
}
```

### 节点描述符 type / define

六个描述符为 memoryGetNode、memoryQueryNode、memorySearchNode、memoryWriteNode、memoryUpdateNode、memoryDeleteNode。`.type` 是对应 Node ID；`.define(workerType, handler)` 定义替换处理器。普通接入优先用 createMemoryWorker；替换处理器需要自行保证 NodeResult 和所有契约。下例仅展示显式失败处理器。

```ts
export const customGet = memoryGetNode.define("MEMORY", async () => ({
  executionId: "example-call", node: "MEMORY.GET", status: "failed",
  error: { code: "NOT_CONFIGURED", message: "Configure the application storage adapter" },
}));
```

可直接运行的数据库接入示例：[examples/worker](examples/integrations/README.zh-CN.md)，包含 SDK 安装、env 配置、调用及资源清理。

## 取消与数据库 SDK

get/query/search/write/update/delete 的第二个参数为可选 `MemoryCallOptions`：`{ signal?: AbortSignal, runtime?: Pick<RuntimeClient, "invoke"> }`。execute 的第三个参数接受 MemoryDefaults 与 MemoryCallOptions。signal 传给对应 MemoryStore/MemorySearchProvider 方法的第二个参数；适配器应传入数据库 SDK 支持的取消选项，不能默认假设每个数据库都能中断执行。

```ts
const result = await memory.search({ query: "database", limit: 5 }, { signal: AbortSignal.timeout(5000) });
if (result.status === "cancelled") console.log(result.error?.code); // MEMORY_CANCELLED
```

直接 SDK 检测到取消时返回 cancelled NodeResult；Runtime 调用还会根据自身取消语义 reject。取消不回滚已完成的数据库写入，不自动重试。Runtime Worker 自动提供当前 signal 和绑定本次执行的 runtime；MEMORY → RETRIEVAL 转接器复用这两者，普通应用无需设置 runtime。数据库/embedding Provider 仍可直接使用原生 SDK；仅需独立执行时才委托 RETRIEVAL。

在 MEMORY Worker 内构造 `RemoteRetrievalSearchProvider` 时，可省略 runtime，继承本次执行绑定的 Runtime；显式 runtime 始终优先，独立 SDK 委托则必须提供它。例如 Worker 内可用 `new RemoteRetrievalSearchProvider({ target: { name: "memories" } })`。

[完整记忆任务示例](memory-workflows.zh-CN.md) 展示关系型与向量存储、显式 embedding、作用域检索及持久化恢复。
