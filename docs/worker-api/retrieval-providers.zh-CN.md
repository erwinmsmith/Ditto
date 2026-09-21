# RETRIEVAL 检索链路与数据库适配

[English](retrieval-providers.md) · [SEARCH 契约与部署](retrieval.zh-CN.md) · [MEMORY](memory.zh-CN.md)

这些实现都在可选入口 `@ditto/core/worker/retrieval` 中。只冻结 `RETRIEVAL.SEARCH` 一个 Node；embedding、融合、重排是可组合的内部 Provider，也可以直接供 MEMORY 的进程内搜索使用。没有新增数据库驱动、数据库实例或索引管理模块。

## 存储与检索的接线

同一个应用插件可以实现 `MemoryStore` 和 `MemorySearchProvider`，两者使用同一个 SQL/Milvus 客户端。MEMORY 的 GET/QUERY/WRITE/UPDATE/DELETE 仍通过 store 操作原数据库。SEARCH 可以有三种接线：

1. 直接注入已有数据库原生 MemorySearchProvider。
2. 用 `createRetrievalMemorySearchProvider` 将本文的检索链路适配为 MemorySearchProvider，无需注册 RETRIEVAL Worker。
3. 用 `RemoteRetrievalSearchProvider` 委托给已注册的 RETRIEVAL.SEARCH，可通过现有 HTTP transport 跨进程执行。

数据库已经支持文本到向量时，使用 `nativeEmbedding: true` 把文本交给数据库。否则，外部 EmbeddingProvider 在查询时生成向量，再交给数据库执行近邻搜索。**查询向量与已存向量必须使用一致的模型、版本、维度及预处理约定**；维度校验只能发现长度错误，不能识别两个等维但不兼容的模型。

批量构建文档向量可以显式调用 `embedContents(..., { purpose: "document" })`，然后由应用通过存储插件写入。SEARCH 不会自动写回向量、重建索引或同步 SQL 与 Milvus 数据。

## Provider API

```ts
interface RetrievalExecutionContext {
  signal?: AbortSignal;
  defaults?: RetrievalDefaults;
}
interface EmbeddingProvider {
  embed(input: {
    contents: readonly unknown[];
    purpose: "query" | "document";
  }, context?: RetrievalExecutionContext): Promise<readonly (readonly number[])[]>;
}
interface RerankProvider {
  rank(input: {
    query: RetrievalQuery;
    candidates: readonly RetrievalCandidate[];
    limit: number;
  }, context?: RetrievalExecutionContext): Promise<readonly {
    index: number; score?: number;
  }[]>;
}
```

`RetrievalSearchProvider.search(input, context?)` 的第二参数可选，已有单参数实现继续兼容。Provider 返回原始结果；仅 Worker/SDK 包装 NodeResult。取消信号是进程内协作式取消，数据库回调需要自行传给驱动；Runtime 的 HTTP 调用不会自动把它传到远端。

| 导出 | 参数与行为 |
| --- | --- |
| `embedContents(provider, input, options?, context?)` | options 为 `{ batchSize?, dimensions? }`；顺序分批、保持输入顺序；空输入不调用模型；校验数量、有限数值、非空向量和跨批次维度。dimensions 是期望输出维度，不会自动截断向量或修改模型请求。 |
| `createVectorSearchProvider({ backend, embedding?, nativeEmbedding?, dimensions? })` | 已有数值向量直接搜索；普通内容先 embedding，或在 nativeEmbedding 模式直接给后端。外部与原生 embedding 不能同时开启。 |
| `createTextSearchProvider(backend)` | 校验非空字符串，全文/BM25 在数据库或搜索引擎执行；不做 embedding。 |
| `createHybridSearchProvider({ branches, candidateLimit?, rrfK?, key? })` | branches 为 `{ provider, strategy, weight? }[]`，并行搜索后执行加权 RRF；weight 默认 1，必须大于 0。 |
| `rerankCandidates(provider, input, context?)` | rank 返回原候选的零起始 index；校验唯一性、范围、结果数量与分数。不会接受重排器生成的新内容。 |
| `createRerankSearchProvider({ search, reranker, candidateLimit? })` | 扩大召回池，重排后截取请求 limit。 |
| `createCosineReranker(embedding)` | 对 query.content 和候选 content 分别 embedding，按余弦相似度降序排序；分数相同保持原顺序，零向量分数为 0。需要更复杂的 cross-encoder 时替换 RerankProvider。 |

HTTP embedding 接口只接受非空字符串；通用 EmbeddingProvider 允许结构化内容。若候选 content 是完整 MemoryItem，传给 cosine reranker 的 embedding 适配器需要显式提取 `memory.content` 文本，不能把整个对象直接交给 HTTP Provider。

融合分数为 `sum(weight / (rrfK + rank))`，rank 从 1 开始。不同检索器的原始分数不直接相加。默认身份为 `[source.target ?? target.name, id ?? source.ref]`；同一分支的重复身份只计一次，使用首次出现的原始排名。缺少 id/ref 时必须提供 key。不同来源若代表同一记录，应由 key 统一身份。等分时保持首次遇到的顺序。

融合候选沿用首次出现的 content/source/metadata，score 替换为融合分数；每一分支的原始 score、rank、weight、source、metadata 留在 `output.metadata.fusion.contributions` 中，键为融合身份。分支输出 metadata 留在 `fusion.branches` 中。任一分支失败，整个搜索失败，并等待其他已开始的分支结束，不返回未声明的部分成功。

## 云端与本地 Provider

Provider 按能力区分为 EmbeddingProvider、RetrievalSearchProvider 和 RerankProvider，不再按部署位置增加平行的 Cloud/Local 类层次：

- 云端 HTTP 与本地 HTTP：复用 createHttpEmbeddingProvider，更换 baseUrl/model/apiKey；本地无认证服务可省略 apiKey，仍遵守网络权限配置。
- 云端 SDK 与进程内模型：直接实现 embed/search/rank，内部调用已有 SDK；模型加载、连接池、设备选择、批处理和关闭由应用拥有的实例负责，不逐请求创建模型或客户端。
- 数据库原生 embedding、全文或图检索：直接调用原 SDK 能力；只有后端需要向量时才在前面添加 embedding。
- 独立搜索引擎或远程检索 API：直接实现 RetrievalSearchProvider，按实际需要选择是否添加融合/重排，不强制走向量流程。

```ts
// encodeBatch 是应用已加载的本地模型或云端 SDK 的适配函数；没有额外 Worker。
const embedding: EmbeddingProvider = {
  embed: ({ contents, purpose }, context) =>
    encodeBatch(contents, { purpose, signal: context?.signal }),
};
const provider = createVectorSearchProvider({ backend: databaseSearch, embedding });
// 普通部署：在 MEMORY 内使用相同 Provider。
const memory = createMemoryWorker({
  store: databaseStore,
  search: createRetrievalMemorySearchProvider({
    provider, target: { name: "agent-memory" }, defaults: config.retrieval,
  }),
});
// 需要独立资源时：把 provider 注册到 RETRIEVAL registry，
// MEMORY 改为 search: new RemoteRetrievalSearchProvider({ runtime, target })。
```

这里改变的是执行位置，数据库 SDK、embedding 模型和结果映射可保持不变。注册到独立进程时，由该进程创建自己的 SDK/模型资源；不要传输连接对象。自动负载检测和自动启动 Worker 不在 Provider 内实现。

## HTTP embedding 与根目录配置

```ts
import { Sandbox } from "@ditto/core/runtime/sandbox";
import { createHttpEmbeddingProvider, embeddingConfigFromEnv } from "@ditto/core/worker/retrieval";
const embedding = createHttpEmbeddingProvider({
  ...embeddingConfigFromEnv(process.env),
  sandbox: new Sandbox(config.workspace, config.sandbox),
  timeoutMs: config.timeoutMs,
});
```

`HttpEmbeddingOptions` 为 `{ baseUrl, model, apiKey?, sandbox, timeoutMs?, fetch? }`，timeoutMs 默认 30000。也可注入自身的 `Pick<Sandbox, "assert">` 权限对象。请求前执行 `sandbox.assert("network", origin)`；禁止重定向。使用 OpenAI-compatible `POST <baseUrl>/embeddings`，请求 `{ model, input: string[], encoding_format: "float" }`；按响应 data.index 恢复顺序并校验向量。供应商其他协议可实现 EmbeddingProvider。

`.env.example` 的 `DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL/API_KEY/MODEL` 仅由显式调用 `embeddingConfigFromEnv` 消费。URL 和 model 必填，API key 可为空（例如本地服务）；网络 origin 还需要加入共享 Sandbox 白名单。数据库地址、凭据和 SDK 初始化继续由应用插件管理。

```yaml
workers:
  retrieval:
    searchLimit: 10
    embedding:
      batchSize: 64
      # dimensions: 1536  # 可选，必须与索引和模型真实输出一致
    hybrid:
      candidateLimit: 100
      rrfK: 60
    rerank:
      candidateLimit: 100
```

配置加载为 `config.retrieval`。limit 优先级是请求 > Worker defaults > YAML > 10。其他数值优先级是 Provider 构造参数 > Worker defaults 对应字段 > YAML > 内置值。两个 candidateLimit 都是召回池下限，实际至少为请求 limit；嵌套重排时，重排需要的数量会传入内部搜索。

batchSize 范围 1..2048；limit/candidateLimit 范围 1..10000；dimensions/rrfK 必须为正安全整数。数值策略放 YAML；超时复用 runtime.timeoutMs，并显式传给 HTTP Provider。直接调用组合 Provider 时传 `{ defaults: config.retrieval }` 作为 context；直接 SDK 则用 `createRetrieval({ providers, defaults: config.retrieval })`。

## SQL 适配：MySQL / PostgreSQL

`createSqlSearchProvider<Row>({ prepare, query, mapRow })` 不持有连接。prepare 接收完整 RetrievalSearchInput，返回 `{ text: string, values: readonly unknown[] }`；query 接收该语句和 context，返回 rows；mapRow 将每行转换为 RetrievalCandidate。所有返回结果仍受 target/limit/候选结构校验。

```ts
// 使用应用已有连接池，二选一；这些库不在 Ditto 的依赖中。
query: async ({ text, values }) => (await pgPool.query(text, [...values])).rows
query: async ({ text, values }) => (await mysqlPool.execute(text, [...values]))[0]
```

应用按自己的表结构实现 prepare，绑定所有用户参数，明确过滤/租户权限、排序与 limit。例如表有 tenant/content 两列：

```sql
-- MySQL；values = [query, tenant, query, limit]
SELECT id, content, MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
FROM memories WHERE tenant = ? AND MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE)
ORDER BY score DESC LIMIT ?

-- PostgreSQL；values = [query, tenant, limit]
SELECT id, content,
       ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score
FROM memories WHERE tenant = $2
  AND to_tsvector('english', content) @@ plainto_tsquery('english', $1)
ORDER BY score DESC LIMIT $3
```

这些示例需要应用已有的全文索引配置。MySQL 原生全文检索、PostgreSQL ts_rank 与 BM25 并非相同排名算法，应注册符合实际实现的 strategy，例如 `keyword`。需要 BM25 时接数据库真实 BM25 能力；测试使用 SQLite FTS5 的 bm25 函数验证此路径。

SQL 适配器不会猜测 schema 或把任意 filter 拼成 SQL。prepare 必须处理或拒绝所有传入的 filter/namespace。返回 score 应表达应用需要的相关性顺序，SQL 必须显式 ORDER BY；Ditto 保留数据库顺序。存储插件已实现原生 search 时，也可直接用下文的 createMemoryRetrievalProvider 复用，省去重复映射。

## Milvus 适配

```ts
const database = createMilvusSearchProvider({
  collection: "memories", vectorField: "embedding", outputFields: ["memory"],
  search: (request, context) => applicationMilvusSearch(request, context),
  // 应用已有客户端执行 client.search(request)，应用封装负责驱动超时/取消。
  scope(input) {
    if (!input.target.namespace || input.filter) throw new Error("Unsupported scope");
    return { filter: "tenant == {tenant}", exprValues: { tenant: input.target.namespace } };
  },
  mapHit: hit => ({
    id: String(hit.id), content: hit.memory, score: hit.score,
    source: { target: "agent-memory", ref: String(hit.id) },
  }),
  params: { ef: 64 },
});
const vector = createVectorSearchProvider({ backend: database, embedding });
```

`MilvusSearchOptions<Hit>` 包含 `collection/vectorField/outputFields/search/mapHit/scope?/params?`。search 回调接收 `{ collection_name, anns_field, data, limit, output_fields, filter?, exprValues?, partition_names?, params? }` 和 context；单次查询 data 为 `[vector]` 或 `[text]`。返回 `{ status: { code?, error_code?, reason? }, results: Hit[] }`，即 Milvus Node 客户端单查询展开结果；其它 SDK 响应由应用回调转换。非成功状态不会被误认为空召回。

应用负责 mapHit 的 ID、内容及 score 语义，例如 L2 distance 越小越相近，若需要“分数越高越好”应显式转换。该适配器不自行改分数。filter/namespace 出现时必须提供 scope mapper；不支持的条件应拒绝，不能静默忽略。options 不会被展开为 Milvus 请求，更不能覆盖固定 collection。

数据库已有文本 embedding 函数时，用 `createVectorSearchProvider({ backend: database, nativeEmbedding: true })`。数据库原生 BM25 也可用 `createTextSearchProvider(database)`，将 vectorField 指向相应稀疏向量字段。具体模型函数、schema、索引和文本检索能力必须在应用数据库中预先配置；Ditto 不会替应用创建。

## 组合示例与 MEMORY 双向转接

```ts
const hybrid = createHybridSearchProvider({ branches: [
  { strategy: "vector", provider: vector },
  { strategy: "keyword", provider: createTextSearchProvider(sqlProvider) },
] });
const pipeline = createRerankSearchProvider({ search: hybrid, reranker: applicationReranker });
const providers = new RetrievalTargetRegistry({
  "agent-memory": { defaultStrategy: "hybrid", providers: { vector, hybrid: pipeline } },
});
// 需要服务边界时注册：createRetrievalWorker({ providers })。
// Graph/temporal/custom 等策略直接注册自己的 SearchProvider，执行数据库遍历或专用算法；无需 embedding。
```

MEMORY 转接函数来自 `@ditto/core/worker/retrieval/adapters/memory`，仅通过类型依赖 MEMORY：

| API | 用法 |
| --- | --- |
| `createMemoryRetrievalProvider(search, mapInput?)` | 将已有 MemorySearchProvider 作为 RETRIEVAL 后端；结果 content 保留完整 MemoryItem。mapInput 可以适配 namespace 等请求信息；有 namespace 却未提供 mapper 会拒绝。 |
| `createRetrievalMemorySearchProvider({ provider, target, strategy?, defaults?, mapOutput? })` | 在 MEMORY 中直接运行检索 pipeline；defaults 显式传 config.retrieval。 |
| `RemoteRetrievalSearchProvider({ runtime, target, mapOutput? })` | 将同一 MEMORY.SEARCH 请求交给 Runtime 中的 RETRIEVAL.SEARCH；后端可以在另一个进程。 |
| `mapMemoryCandidates(output)` | 默认结果映射：candidate.content 必须是完整 MemoryItem，candidate.id 若存在必须等于 memory.id；保留 key/content/metadata、score、命中 metadata 和 source。 |

若候选只携带 ID 或文本，自定义 mapOutput 一次批量补全/映射。默认映射不会从文本猜测 Memory ID。保持原生 search 插件方向为“数据库 → Retrieval Provider”，不能把已委托 RETRIEVAL 的 MEMORY.SEARCH 再作为同一 RETRIEVAL 的后端，避免递归。

## 验证范围

`npm run check` 包含：真实 SQLite FTS5/BM25 参数化查询；本地 HTTP embedding 请求、响应索引、权限和超时；向量维度、批次与空输入；RRF 数值、去重与失败等待；cosine 重排与非法候选；Milvus 请求/响应协议；本地和委托 MEMORY 的完整记录保留；可选导出、配置与既有 HTTP Worker 通信测试。

Milvus/MySQL/PostgreSQL 客户端由应用注入；本仓库测试没有连接这三种真实服务，也不宣称验证其索引吞吐或第三方模型的相关性质量。原始文档要求的 SEARCH 链路及可替换边界已覆盖；自动扩缩容、服务发现、租户限流和监控不在本轮范围内。
