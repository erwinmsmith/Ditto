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

## Cloud and local providers

Provider interfaces describe capability (EmbeddingProvider, RetrievalSearchProvider, RerankProvider), without an additional Cloud/Local class hierarchy:

- Cloud HTTP and local HTTP use createHttpEmbeddingProvider with different baseUrl/model/apiKey. An unauthenticated local endpoint may omit apiKey; network permission checks still apply.
- Cloud SDKs and in-process model handles implement embed/search/rank directly. Application-owned instances manage model loading, pools, devices, batching and cleanup; avoid recreating clients/models per request.
- Native database embedding, full-text or graph retrieval calls the existing SDK. Add external embedding only when the backend expects vectors.
- Separate search engines and remote search APIs implement RetrievalSearchProvider; fusion/reranking are optional and vector processing is not mandatory.

```ts
// encodeBatch adapts an already loaded local model or cloud SDK; no extra Worker.
const embedding: EmbeddingProvider = {
  embed: ({ contents, purpose }, context) =>
    encodeBatch(contents, { purpose, signal: context?.signal }),
};
const provider = createVectorSearchProvider({ backend: databaseSearch, embedding });
const memory = createMemoryWorker({
  store: databaseStore,
  search: createRetrievalMemorySearchProvider({
    provider, target: { name: "agent-memory" }, defaults: config.retrieval,
  }),
});
// For independent resources, register provider in RETRIEVAL's registry and use
// search: new RemoteRetrievalSearchProvider({ runtime, target }) in MEMORY.
```

Moving execution preserves SDK, embedding and result-mapping choices. A separate process creates its own SDK/model resources; connection objects are not transported. Providers do not implement automatic load detection or Worker startup.

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

## Protocol references

Protocol references: [OpenAI embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create), [Milvus Node search](https://milvus.io/api-reference/node/v2.6.x/Vector/search.md), [PostgreSQL text search](https://www.postgresql.org/docs/17/textsearch-controls.html), [RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion).

## Examples for each API

Complete source: [examples/retrieval.ts](examples/retrieval.ts). The functions below share its imports; importing the file executes no examples. Applications supply database, model, or MCP resources. Choose the function you need; writes, deletes, and model calls perform real operations when invoked.

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

embed is the raw SDK port. embedContents batches sequentially and validates output. validateVector(value, dimensions?) returns void or throws RETRIEVAL_INVALID_EMBEDDING. Supply the actual model dimension.

```ts
export async function embeddingApis(embedding: EmbeddingProvider, dimensions: number) {
  const direct = await embedding.embed({ contents: ["query text"], purpose: "query" });
  const documents = await embedContents(embedding, { contents: ["document A", "document B"], purpose: "document" }, { batchSize: 32, dimensions });
  validateVector(documents[0], dimensions); // Returns void; throws on invalid/empty/mismatched vectors.
  return { direct, documents };
}
```

### embeddingConfigFromEnv / createHttpEmbeddingProvider

The env helper returns baseUrl/model/apiKey; the factory creates the HTTP provider. Load .env through Node --env-file or your application first. YAML stores behavior such as batchSize/dimensions.

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

### createVectorSearchProvider: three paths

The functions cover external embedding, database-native embedding, and precomputed vectors. Choose the supported path. embedding and nativeEmbedding cannot both be enabled.

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

### createTextSearchProvider: text search

Returns a RetrievalSearchProvider requiring nonempty text. It supplies no embedding or inverted index; the backend owns retrieval, sorting, and filtering.

```ts
export async function textSearch(backend: RetrievalSearchProvider) {
  return createTextSearchProvider(backend).search({ ...request, strategy: "keyword" });
}
```

### createHybridSearchProvider: fusion

Branches run concurrently with their own strategy and expanded limit. Output contains original candidates ranked by RRF and fusion metadata. Candidate identity must remain meaningful across backends.

```ts
export async function hybridSearch(vector: RetrievalSearchProvider, text: RetrievalSearchProvider) {
  const hybrid = createHybridSearchProvider({ candidateLimit: 50, rrfK: 60,
    branches: [{ provider: vector, strategy: "vector", weight: 1 }, { provider: text, strategy: "keyword", weight: 0.7 }],
  });
  return hybrid.search({ ...request, strategy: "hybrid" });
}
```

### RerankProvider.rank / rerankCandidates / createCosineReranker / createRerankSearchProvider

rank returns indexes/scores; rerankCandidates maps them back to original candidates. Count must equal min(limit, candidates.length), with valid unique indexes. Cosine embeds candidate content; extract text in the embedding adapter when content is a MemoryItem.

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

### createSqlSearchProvider: SQL SDK injection

Assumes PostgreSQL memories(id, content, tenant), rejecting unsupported filters/options. Inject the existing pool through query. MySQL uses the same factory with its own placeholders/query, shown earlier. Namespace binds a tenant value but does not replace authorization.

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

### createMilvusSearchProvider: Milvus SDK injection

Adapt SDK search to the documented request/response. Status code=0 or error_code=Success indicates success. mapHit keeps a full MemoryItem for default bridging. Database fields, indexes, and embedding functions must already exist.

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

Bridges native Memory search to Retrieval and back. Default mapping requires complete MemoryItems in candidate.content; candidate.id, when present, must equal content.id.

```ts
export async function nativeMemoryInRetrieval(nativeSearch: MemorySearchProvider) {
  const provider = createMemoryRetrievalProvider(nativeSearch);
  const output = await provider.search(request);
  return mapMemoryCandidates(output); // content must be a complete MemoryItem, not just text.
}
```

### createMemoryRetrievalProvider mapInput

Requests with target.namespace require mapInput. This is an application filter DSL; the database plugin must support tenant and authorize the caller independently.

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

### createRetrievalMemorySearchProvider: in-process reuse

No RETRIEVAL Worker is registered. Default mapping still requires complete MemoryItems; provider can be any search composition. Request strategy overrides constructor strategy. Connections remain application-owned.

```ts
export async function localMemoryPipeline(store: MemoryStore, provider: RetrievalSearchProvider) {
  const search = createRetrievalMemorySearchProvider({ provider, target: { name: "kb" }, strategy: "vector", defaults: { searchLimit: 5 } });
  const runtime = createDitto({ workers: [createMemoryWorker({ store, search })] });
  try { return await runtime.invoke("MEMORY.SEARCH", { query: "agent memory", limit: 3 }); }
  finally { await runtime.close(); }
}
```

### RemoteRetrievalSearchProvider.search: delegation

Construction opens no connections and starts no Workers. search returns raw MemorySearchOutput; MEMORY adds NodeResult. This example routes locally; HTTP registration preserves the same Memory request.

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

### mapOutput: custom complete-record mapping

Pass mapOutput: mapTextCandidates when candidate.content already is complete business content. For fragment/id-only indexes, batch-load full records instead of representing fragments as complete Memory.

```ts
export function mapTextCandidates(output: RetrievalSearchOutput) {
  return output.candidates.map(candidate => {
    if (!candidate.id) throw new Error("The application requires candidate ids");
    return { memory: { id: candidate.id, content: candidate.content }, ...(candidate.score === undefined ? {} : { score: candidate.score }) };
  }); // Use as mapOutput only when content is the application's complete memory content.
}
```
