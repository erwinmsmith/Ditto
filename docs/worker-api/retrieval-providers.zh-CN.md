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

## 逐 API 使用示例

完整代码：[examples/retrieval.ts](examples/retrieval.ts)。下列函数共用该文件的 imports；函数不会在导入时自动执行。数据库、模型和 MCP 参数由应用注入，不是 Ditto 内置的模拟后端。选择需要的函数调用；写入、删除、模型调用等会产生对应的真实操作。

```ts
import { createDitto, createMemoryWorker, loadRuntimeConfigFile } from "@ditto/core";
import type { MemorySearchProvider, MemoryStore, MemoryItem } from "@ditto/core/worker/memory";
import {
  createRetrieval, createRetrievalWorker, RetrievalTargetRegistry, RetrievalError, retrievalSearchNode,
  embedContents, validateVector, createVectorSearchProvider, createTextSearchProvider,
  createHybridSearchProvider, createCosineReranker, rerankCandidates, createRerankSearchProvider,
  createHttpEmbeddingProvider, embeddingConfigFromEnv, createSqlSearchProvider, createMilvusSearchProvider,
  type RetrievalSearchProvider, type RetrievalSearchInput, type RetrievalSearchOutput,
  type EmbeddingProvider, type RerankProvider, type SqlSearchOptions, type MilvusSearchOptions,
} from "@ditto/core/worker/retrieval";
import {
  createMemoryRetrievalProvider, createRetrievalMemorySearchProvider,
  RemoteRetrievalSearchProvider, mapMemoryCandidates,
} from "@ditto/core/worker/retrieval/adapters/memory";

export const request: RetrievalSearchInput = { query: { content: "agent memory" }, target: { name: "kb" }, limit: 5 };
```

### EmbeddingProvider.embed / embedContents / validateVector

embed 是 SDK 适配接口，直接调用不附加批次包装；embedContents 顺序分批并校验维度。validateVector(value, dimensions?) 成功返回 void，失败抛 RETRIEVAL_INVALID_EMBEDDING。示例中的 dimensions 应等于实际模型输出维度。

```ts
export async function embeddingApis(embedding: EmbeddingProvider, dimensions: number) {
  const direct = await embedding.embed({ contents: ["query text"], purpose: "query" });
  const documents = await embedContents(embedding, { contents: ["document A", "document B"], purpose: "document" }, { batchSize: 32, dimensions });
  validateVector(documents[0], dimensions); // Returns void; throws on invalid/empty/mismatched vectors.
  return { direct, documents };
}
```

### embeddingConfigFromEnv / createHttpEmbeddingProvider

前者只读取 env 并返回 baseUrl/model/apiKey，后者创建实际 HTTP embedding Provider。函数需要 .env 已由 Node --env-file 或应用加载；Ditto 不隐式加载。YAML 仅保存 batchSize/dimensions 等行为参数。

```ts
export async function httpEmbedding() {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const runtime = createDitto({ config });
  try {
    const embedding = createHttpEmbeddingProvider({ ...embeddingConfigFromEnv(process.env), sandbox: runtime.services.sandbox, timeoutMs: config.timeoutMs });
    return await embedContents(embedding, { contents: ["query text"], purpose: "query" }, {}, { defaults: config.retrieval });
  } finally { await runtime.close(); }
}
```

### createVectorSearchProvider：三种输入路径

三个函数分别展示外部 embedding、数据库原生 embedding、预计算向量。选择一种即可；后端能否接收文本取决于数据库配置。nativeEmbedding 与 embedding 不能同时设置。

```ts
export async function externalVector(backend: RetrievalSearchProvider, embedding: EmbeddingProvider) {
  const vector = createVectorSearchProvider({ backend, embedding });
  return vector.search(request);
}
export async function nativeVector(backend: RetrievalSearchProvider) {
  return createVectorSearchProvider({ backend, nativeEmbedding: true }).search(request);
}
export async function precomputedVector(backend: RetrievalSearchProvider, vector: readonly number[]) {
  return createVectorSearchProvider({ backend, dimensions: vector.length }).search({ ...request, query: { content: vector } });
}
```

### createTextSearchProvider：文本检索

返回 RetrievalSearchProvider。要求非空文本；不执行向量化，不自带 BM25/倒排索引算法。真正的检索、排序和过滤交给传入后端。

```ts
export async function textSearch(backend: RetrievalSearchProvider) {
  return createTextSearchProvider(backend).search({ ...request, strategy: "keyword" });
}
```

### createHybridSearchProvider：融合

两个分支会并行运行，各自收到 branch.strategy 和扩大的 limit。成功返回经过 RRF 排序的原候选及 fusion 元数据。分支可包含不同数据库，但 key 必须能正确区分/统一候选身份。

```ts
export async function hybridSearch(vector: RetrievalSearchProvider, text: RetrievalSearchProvider) {
  const hybrid = createHybridSearchProvider({ candidateLimit: 50, rrfK: 60,
    branches: [{ provider: vector, strategy: "vector", weight: 1 }, { provider: text, strategy: "keyword", weight: 0.7 }],
  });
  return hybrid.search({ ...request, strategy: "hybrid" });
}
```

### RerankProvider.rank / rerankCandidates / createCosineReranker / createRerankSearchProvider

rank 输出 `{ index, score? }[]`；rerankCandidates 将索引还原为原候选。返回数量必须等于 min(limit, candidates.length)，索引唯一且合法。cosine 使用候选 content 做 document embedding；若 content 是 MemoryItem，应在 embedding 适配器内提取实际文本。

```ts
export async function rerankApis(embedding: EmbeddingProvider, output: RetrievalSearchOutput) {
  const reranker = createCosineReranker(embedding);
  const input = { query: request.query, candidates: output.candidates, limit: Math.max(1, Math.min(3, output.candidates.length)) };
  const order = await reranker.rank(input); // Raw zero-based indexes and scores.
  const candidates = await rerankCandidates(reranker, input); // Original candidates in ranked order.
  return { order, candidates };
}
export async function rerankSearch(search: RetrievalSearchProvider, reranker: RerankProvider) {
  return createRerankSearchProvider({ search, reranker, candidateLimit: 50 }).search(request);
}
```

### createSqlSearchProvider：可注入 SQL SDK

此例假定 PostgreSQL memories(id, content, tenant) 表，并显式拒绝不支持的 filter/options。query 回调使用应用已有连接池。MySQL 使用同一工厂，但 prepare 必须换成该方言的占位符和查询；前文给出对应 SQL。本例按 namespace 绑定租户参数，权限校验仍由应用完成。

```ts
interface SqlRow { id: string; content: string; score: number; }
export function sqlSearch(query: SqlSearchOptions<SqlRow>["query"]) {
  return createSqlSearchProvider<SqlRow>({
    prepare(input) {
      if (typeof input.query.content !== "string" || !input.target.namespace || input.filter || input.options) {
        throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Expected text and namespace without additional filters or options");
      }
      return {
        text: "SELECT id, content, ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score FROM memories WHERE tenant = $2 AND to_tsvector('english', content) @@ plainto_tsquery('english', $1) ORDER BY score DESC, id ASC LIMIT $3",
        values: [input.query.content, input.target.namespace, input.limit],
      };
    },
    query, // e.g. async ({ text, values }) => (await pgPool.query(text, [...values])).rows
    mapRow: row => ({ id: row.id, content: row.content, score: row.score }),
  });
}
```

### createMilvusSearchProvider：可注入 Milvus SDK

将现有 SDK search 适配为固定请求/响应接口；status code=0 或 error_code=Success 才成功。mapHit 返回完整 MemoryItem，便于默认 MEMORY 转接。数据库内索引、字段、embedding 函数需预先存在。

```ts
interface MilvusHit { id: string | number; score: number; memory: MemoryItem; }
export function milvusSearch(search: MilvusSearchOptions<MilvusHit>["search"]) {
  return createMilvusSearchProvider<MilvusHit>({ collection: "memories", vectorField: "embedding", outputFields: ["memory"],
    search, // Adapt the application's SDK response to { status, results }.
    scope(input) {
      if (!input.target.namespace || input.filter || input.options) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "Expected a namespace without extra filters or options");
      return { filter: "tenant == {tenant}", exprValues: { tenant: input.target.namespace } };
    },
    mapHit: hit => ({ id: String(hit.id), content: hit.memory, score: hit.score }),
  });
}
```

### createMemoryRetrievalProvider / mapMemoryCandidates

原生 MemorySearchProvider → RetrievalSearchProvider → MemorySearchOutput。默认映射要求 candidate.content 是完整 MemoryItem；如果 candidate.id 存在，必须等于 content.id。

```ts
export async function nativeMemoryInRetrieval(nativeSearch: MemorySearchProvider) {
  const provider = createMemoryRetrievalProvider(nativeSearch);
  const output = await provider.search(request);
  return mapMemoryCandidates(output); // content must be a complete MemoryItem, not just text.
}
```

### createMemoryRetrievalProvider 的 mapInput

有 target.namespace 时必须显式提供 mapInput，否则拒绝。下面只是一种应用 filter DSL，数据库插件必须明确支持 tenant 字段；不能把 namespace 当作已经鉴权的身份。

```ts
export function nativeMemoryWithNamespace(nativeSearch: MemorySearchProvider) {
  return createMemoryRetrievalProvider(nativeSearch, input => {
    if (!input.target.namespace) throw new RetrievalError("RETRIEVAL_INVALID_INPUT", "A namespace is required");
    return {
      query: input.query.content, filter: { ...input.filter, tenant: input.target.namespace },
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
      ...(input.options === undefined ? {} : { options: input.options }),
    };
  }); // The native plugin must implement this tenant filter and enforce caller authorization.
}
```

### createRetrievalMemorySearchProvider：进程内复用

无需注册 RETRIEVAL Worker。默认 mapOutput 仍要求完整 MemoryItem 候选，provider 可以是 vector/text/hybrid/rerank 组合。策略优先级为 MEMORY 请求 strategy > 此构造参数 strategy；插件连接由应用拥有。

```ts
export async function localMemoryPipeline(store: MemoryStore, provider: RetrievalSearchProvider) {
  const search = createRetrievalMemorySearchProvider({ provider, target: { name: "kb" }, strategy: "vector", defaults: { searchLimit: 5 } });
  const runtime = createDitto({ workers: [createMemoryWorker({ store, search })] });
  try { return await runtime.invoke("MEMORY.SEARCH", { query: "agent memory", limit: 3 }); }
  finally { await runtime.close(); }
}
```

### RemoteRetrievalSearchProvider.search：委托执行

构造不打开连接、不启动 Worker。search 原始返回 MemorySearchOutput；放入 MEMORY Worker 后才包装 NodeResult。示例在同一 Runtime 内路由，换成 HTTP 远端注册不改 MEMORY 请求。

```ts
export async function delegatedMemory(store: MemoryStore, provider: RetrievalSearchProvider) {
  const { runtime } = setupRetrieval(provider);
  const search = new RemoteRetrievalSearchProvider({ runtime, target: { name: "kb" } });
  runtime.register(createMemoryWorker({ store, search }));
  try {
    const raw = await search.search({ query: "agent memory", limit: 3 }); // Raw MemorySearchOutput.
    const routed = await runtime.invoke("MEMORY.SEARCH", { query: "agent memory", limit: 3 });
    return { raw, routed };
  } finally { await runtime.close(); }
}
```

### mapOutput：自定义完整记录映射

当 candidate.content 只是业务内容时，可在 createRetrievalMemorySearchProvider 或 RemoteRetrievalSearchProvider 中传 `mapOutput: mapTextCandidates`。若索引只含片段或 ID，应改成一次批量读取真实完整记录；不要把片段冒充完整 Memory。

```ts
export function mapTextCandidates(output: RetrievalSearchOutput) {
  return output.candidates.map(candidate => {
    if (!candidate.id) throw new Error("The application requires candidate ids");
    return { memory: { id: candidate.id, content: candidate.content }, ...(candidate.score === undefined ? {} : { score: candidate.score }) };
  }); // Use as mapOutput only when content is the application's complete memory content.
}
```

## 与 CONTEXT 组合

数据库检索、embedding、融合与重排 Provider 可注入 createRagStrategy 的 retrieve 步骤。CONTEXT 不要求单独启动 RETRIEVAL；检索后端生命周期仍由应用管理。 [完整 CONTEXT API 与调用示例](context.zh-CN.md)。

## Context 检索适配器

从 `@ditto/core/worker/retrieval/adapters/context` 导入 `createRetrievalContextStrategy` 和 `mapContextCandidates`；Core 不导入这个可选模块。

`createRetrievalContextStrategy(options)` 返回 ContextRagStrategy。provider 与 runtime 不能同时设置：provider 在本地执行 RetrievalSearchProvider，可复用 SQL、Milvus、向量/embedding、hybrid 流水线；runtime 调用 RETRIEVAL.SEARCH；在 CONTEXT Worker 内可同时省略二者以继承本次执行的 Runtime，显式 runtime 始终优先。需预先注册本地或远端 RETRIEVAL Worker，按现有 direct/IPC/HTTP 方式部署。

| 参数 | 行为 |
| --- | --- |
| target | 必填逻辑 RetrievalTarget，构造时快照 |
| strategy | 可选检索策略名称 |
| defaults | RetrievalDefaults；用于本地流水线，也为两种模式提供缺省 limit；委托计算采用目标 Worker 配置 |
| mapInput(input) | 可选 ContextSelectInput → RetrievalSearchInput；显式处理 corpus、租户 namespace、filter 和授权 |
| mapOutput(output) | 可选完整 RetrievalSearchOutput → ContextItem[] 或 Promise；默认 mapContextCandidates |

默认映射要求 query，将 strategy.options 转为检索 options；limit 使用请求值、searchLimit 或 10，并限制最多 10000。显式提供 corpus 时必须配置 mapInput，避免丢失范围。limit=0 不调用后端；检索后仍由 Context 执行条数和 token 预算。

`mapContextCandidates(output)` 要求内容为 JSON。ID 由 target.name/type/namespace 及候选 ID 生成稳定哈希；无 ID 时用 source.ref，再回退 content。source.ref 映射为 source.uri，保留 metadata 和 score，补充 retrievalTarget。内容不合法抛 INVALID_PROVIDER_OUTPUT；业务记录需自定义 mapOutput。Context.SELECT 负责去重和预算，不覆盖缓存。例如 `mapContextCandidates({ target: { name: "docs" }, candidates: [{ id: "1", content: "Evidence", score: 0.8 }] })` 返回一个稳定 ContextItem，含对应内容和 score 元数据。

```ts
import { createContext, type RuntimeClient } from "@ditto/core";
import type { RetrievalSearchProvider } from "@ditto/core/worker/retrieval";
import { createRetrievalContextStrategy, mapContextCandidates } from "@ditto/core/worker/retrieval/adapters/context";
export function contextSearch(provider: RetrievalSearchProvider, runtime: RuntimeClient) {
  const inline = createContext({ services: { ragStrategy: createRetrievalContextStrategy({
    provider, target: { name: "documents" }, strategy: "vector",
  }) } });
  const delegated = createContext({ services: { ragStrategy: createRetrievalContextStrategy({
    runtime, target: { name: "documents" }, strategy: "vector", mapOutput: mapContextCandidates,
  }) } });
  const input = { context: { items: [] }, purpose: "infer" as const, query: "agent runtime",
    strategy: { kind: "rag" as const }, limit: 5 };
  return Promise.all([inline.select(input), delegated.select(input)]);
}
```

将策略注入 Context services.ragStrategy。每次调用的 signal 传入本地 Provider 或委托调用；未显式设置 runtime 时，内置 Worker 使用绑定当前执行的 Runtime，使已接收的 Graph 可以在关闭期间正常完成。网络取消目前停止调用方等待，不会终止远端数据库操作。[可运行 SQLite FTS5 示例](examples/integrations/context-retrieval.ts)。

在 MEMORY Worker 内构造 `RemoteRetrievalSearchProvider` 时，可省略 runtime，继承本次执行绑定的 Runtime；显式 runtime 始终优先，独立 SDK 委托则必须提供它。例如 Worker 内可用 `new RemoteRetrievalSearchProvider({ target: { name: "memories" } })`。
