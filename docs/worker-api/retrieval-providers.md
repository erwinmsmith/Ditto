# RETRIEVAL pipelines and database adapters

[简体中文](retrieval-providers.zh-CN.md) · [SEARCH contract and deployment](retrieval.md) · [MEMORY](memory.md)

All implementations below belong to the optional `@ditto/core/worker/retrieval` entry. SEARCH remains the only Node. Embedding, fusion and reranking are composable providers that can also run inside MEMORY without registering a RETRIEVAL Worker. No database driver, server, schema or index manager is included.

## Storage and search

An application plugin can implement both MemoryStore and MemorySearchProvider using the same SQL/Milvus connection. MEMORY CRUD continues to use that store. SEARCH can use the native plugin directly, run this pipeline through `createRetrievalMemorySearchProvider`, or delegate to a separately deployed RETRIEVAL.SEARCH through `RemoteRetrievalSearchProvider` and the existing Runtime transport.

When the database has configured text-to-vector functions, use `nativeEmbedding: true`. Otherwise an external EmbeddingProvider computes query vectors before database nearest-neighbor search. Query and stored vectors must use compatible model versions, dimensions and preprocessing; dimension checks cannot detect incompatible models with equal vector lengths.

Applications may explicitly call `embedContents` with purpose `document` during indexing, then write through their storage plugin. SEARCH never writes embeddings, creates indexes or synchronizes SQL and Milvus records.

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

`RetrievalSearchProvider.search(input, context?)` accepts an optional second parameter; existing single-argument implementations still work. Providers return raw outputs; the Worker/SDK supplies NodeResult. Cancellation is cooperative and local: database callbacks must forward the signal to a capable driver. Runtime HTTP invocation does not propagate it to the remote server.

| Export | Arguments and behavior |
| --- | --- |
| `embedContents(provider, input, options?, context?)` | options is `{ batchSize?, dimensions? }`. Sequential bounded batches preserve input order. Empty input avoids model calls. Validates counts, finite values, nonempty vectors and dimensions across batches. dimensions is an expected output size; it neither truncates vectors nor changes model requests. |
| `createVectorSearchProvider({ backend, embedding?, nativeEmbedding?, dimensions? })` | Precomputed numerical vectors go straight to search; other content is embedded or forwarded to a native embedding backend. External and native embedding are mutually exclusive. |
| `createTextSearchProvider(backend)` | Requires a nonempty string; executes full-text/BM25 in the database/search engine, without embedding. |
| `createHybridSearchProvider({ branches, candidateLimit?, rrfK?, key? })` | branches is `{ provider, strategy, weight? }[]`. Searches run concurrently, followed by weighted RRF. Weights default to 1 and must be positive. |
| `rerankCandidates(provider, input, context?)` | rank returns zero-based indexes into the original candidates. Validates unique indexes, range, exact result count and finite scores; never accepts fabricated candidate content. |
| `createRerankSearchProvider({ search, reranker, candidateLimit? })` | Expands the candidate pool, reranks, then returns the requested limit. |
| `createCosineReranker(embedding)` | Embeds query.content and candidate content separately, sorts by descending cosine similarity, preserves ties and scores zero vectors as 0. Substitute a RerankProvider for a cross-encoder or other scoring model. |

The HTTP embedding implementation accepts nonempty strings; the generic interface also supports structured content. For complete MemoryItem candidates, wrap the embedding provider to explicitly extract memory.content before sending document text to HTTP. No implicit JSON-to-text conversion is performed.

Fusion score is `sum(weight / (rrfK + rank))`, with rank starting at 1. Raw scores from different scales are not added. Default identity is `[source.target ?? target.name, id ?? source.ref]`; duplicates count once per branch using their first original rank. Without id/ref, supply key. To merge equivalent records from different sources, define a shared key. Ties retain first-seen order.

Fused candidates retain the first content/source/metadata, with score replaced by the fused score. Each branch's original score, rank, weight, source and metadata remain in `output.metadata.fusion.contributions`, keyed by identity; branch output metadata remains in `fusion.branches`. A branch failure fails the operation after all accepted branches settle, preventing an undeclared partial success or premature capacity release.

## HTTP embedding and root configuration

```ts
import { Sandbox } from "@ditto/core/runtime/sandbox";
import { createHttpEmbeddingProvider, embeddingConfigFromEnv } from "@ditto/core/worker/retrieval";
const embedding = createHttpEmbeddingProvider({
  ...embeddingConfigFromEnv(process.env),
  sandbox: new Sandbox(config.workspace, config.sandbox),
  timeoutMs: config.timeoutMs,
});
```

HttpEmbeddingOptions is `{ baseUrl, model, apiKey?, sandbox, timeoutMs?, fetch? }`; timeout defaults to 30000 ms. sandbox is a `Pick<Sandbox, "assert">`. It checks the endpoint origin before requesting and disallows redirects. The OpenAI-compatible protocol posts `{ model, input: string[], encoding_format: "float" }` to `<baseUrl>/embeddings`, reconstructs input order from data.index and validates vectors. Other protocols implement EmbeddingProvider directly.

Root `.env.example` contains `DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL/API_KEY/MODEL`, consumed only by explicit `embeddingConfigFromEnv`. Endpoint and model are required; API key may be absent for local services. Also allow the endpoint origin in the shared Sandbox network policy. Database credentials and client initialization stay in application plugins.

```yaml
workers:
  retrieval:
    searchLimit: 10
    embedding:
      batchSize: 64
      # dimensions: 1536  # optional; must match model output and stored vectors
    hybrid:
      candidateLimit: 100
      rrfK: 60
    rerank:
      candidateLimit: 100
```

This loads as config.retrieval. Limit precedence is request > Worker defaults > YAML > 10. Other parameters use provider constructor options > matching Worker defaults field > YAML > built-in value. candidateLimit is a pool floor, never below the requested limit. A reranker passes its required pool size into the inner search.

batchSize accepts 1..2048; limit/candidateLimit 1..10000; dimensions/rrfK positive safe integers. Numerical policy belongs in YAML; explicitly pass config.timeoutMs to HTTP embedding to share runtime.timeoutMs. Direct provider calls pass `{ defaults: config.retrieval }` as context; standalone SDK construction uses `createRetrieval({ providers, defaults: config.retrieval })`.

## SQL: MySQL / PostgreSQL

`createSqlSearchProvider<Row>({ prepare, query, mapRow })` owns no connection. prepare receives RetrievalSearchInput and returns `{ text: string, values: readonly unknown[] }`; query receives that statement and context and returns rows; mapRow converts each row to RetrievalCandidate. Output target, limit and candidate shapes are validated.

```ts
// Adapt an existing application-owned pool; these libraries are not Ditto dependencies.
query: async ({ text, values }) => (await pgPool.query(text, [...values])).rows
query: async ({ text, values }) => (await mysqlPool.execute(text, [...values]))[0]
```

prepare owns schema, permissions, filtering, ordering and limits. Bind every caller value. Example queries for an existing table with tenant/content columns:

```sql
-- MySQL; values = [query, tenant, query, limit]
SELECT id, content, MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
FROM memories WHERE tenant = ? AND MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE)
ORDER BY score DESC LIMIT ?

-- PostgreSQL; values = [query, tenant, limit]
SELECT id, content,
       ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score
FROM memories WHERE tenant = $2
  AND to_tsvector('english', content) @@ plainto_tsquery('english', $1)
ORDER BY score DESC LIMIT $3
```

Applications configure the appropriate full-text indexes. MySQL native full-text scoring and PostgreSQL ts_rank are not interchangeable with BM25; register an accurate strategy such as keyword. For BM25, connect an actual BM25 backend. Tests execute SQLite FTS5's bm25 function through this adapter.

The adapter does not infer schemas or interpolate arbitrary filters. prepare must handle or reject every supplied filter/namespace. SQL must order results explicitly; Ditto preserves that order and score semantics. If the storage plugin already implements search, createMemoryRetrievalProvider avoids repeating result mapping.

## Milvus

```ts
const database = createMilvusSearchProvider({
  collection: "memories", vectorField: "embedding", outputFields: ["memory"],
  search: (request, context) => applicationMilvusSearch(request, context),
  // Wrap the application's client.search(request); the wrapper owns driver deadlines/cancellation.
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

MilvusSearchOptions<Hit> contains collection/vectorField/outputFields/search/mapHit/scope?/params?. search receives `{ collection_name, anns_field, data, limit, output_fields, filter?, exprValues?, partition_names?, params? }` and context. A single query's data is `[vector]` or `[text]`. Return `{ status: { code?, error_code?, reason? }, results: Hit[] }`, matching the Node client's flattened single-query results; adapt other SDK shapes in the callback. Failed statuses never become empty success.

mapHit owns ID, content and score interpretation. For example, lower L2 distance is better; explicitly transform it if the application needs higher-is-better scores. The adapter does not change scores. namespace/filter requires a scope mapper, which must reject unsupported conditions. input.options is not spread into Milvus requests and cannot override a fixed collection.

Use `createVectorSearchProvider({ backend: database, nativeEmbedding: true })` when the database already has text embedding configured. Native BM25 can use `createTextSearchProvider(database)`, with vectorField naming the appropriate sparse field. Schema, embedding functions, indexes and text-search capabilities must already be configured in the application database.

## Composition and MEMORY adapters

```ts
const hybrid = createHybridSearchProvider({ branches: [
  { strategy: "vector", provider: vector },
  { strategy: "keyword", provider: createTextSearchProvider(sqlProvider) },
] });
const pipeline = createRerankSearchProvider({ search: hybrid, reranker: applicationReranker });
const providers = new RetrievalTargetRegistry({
  "agent-memory": { defaultStrategy: "hybrid", providers: { vector, hybrid: pipeline } },
});
// Register createRetrievalWorker({ providers }) when a service boundary is needed.
// Register graph/temporal/custom SearchProviders directly for database traversal or other algorithms.
```

MEMORY adapters are exported from `@ditto/core/worker/retrieval/adapters/memory`, with only type dependencies on MEMORY:

| API | Behavior |
| --- | --- |
| `createMemoryRetrievalProvider(search, mapInput?)` | Reuses a native MemorySearchProvider inside RETRIEVAL; content preserves the complete MemoryItem. mapInput adapts namespace or other request details. A namespace without a mapper is rejected. |
| `createRetrievalMemorySearchProvider({ provider, target, strategy?, defaults?, mapOutput? })` | Runs a pipeline directly inside MEMORY. Explicitly pass config.retrieval as defaults. |
| `RemoteRetrievalSearchProvider({ runtime, target, mapOutput? })` | Delegates unchanged MEMORY.SEARCH semantics through Runtime to RETRIEVAL.SEARCH, locally or across processes. |
| `mapMemoryCandidates(output)` | Default mapping requires candidate.content to be a complete MemoryItem; candidate.id, if present, must equal memory.id. Preserves key/content/metadata, score, hit metadata and source. |

If candidates contain only IDs or text, supply a batch mapOutput to hydrate/map records. The default mapper never invents Memory IDs. Do not feed a MEMORY.SEARCH that already delegates to RETRIEVAL back into the same RETRIEVAL backend: that would recurse.

## Verification and protocol references

`npm run check` covers real SQLite FTS5/BM25 parameterized searches, local HTTP embedding wire behavior, dimensions and batching, RRF scores/deduplication/failure draining, cosine reranking and invalid indexes, Milvus protocol mapping, full Memory preservation, local/delegated execution, optional exports/configuration and existing HTTP Worker transport tests.

Tests do not connect to live Milvus/MySQL/PostgreSQL services or measure their index throughput or third-party embedding quality. Autoscaling, discovery, tenant throttling and monitoring remain outside this iteration.

Protocol references: [OpenAI embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create), [Milvus Node search](https://milvus.io/api-reference/node/v2.6.x/Vector/search.md), [PostgreSQL text search](https://www.postgresql.org/docs/17/textsearch-controls.html), [RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion).
