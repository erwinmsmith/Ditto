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

// example: setup
export function setupRetrieval(provider: RetrievalSearchProvider) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "vector", providers: { vector: provider } } });
  const runtime = createDitto({ config, workers: [createRetrievalWorker({ providers, concurrency: 4 })] });
  const retrieval = createRetrieval({ providers, defaults: config.retrieval });
  return { runtime, retrieval };
}

// example: search
export async function retrievalSearch(provider: RetrievalSearchProvider) {
  const { runtime, retrieval } = setupRetrieval(provider);
  try {
    const local = await retrieval.search(request);
    const routed = await runtime.invoke("RETRIEVAL.SEARCH", request);
    if (routed.status !== "success" || !routed.output) throw new Error(routed.error?.code ?? routed.status);
    return { local, candidates: routed.output.candidates, target: routed.output.target };
  } finally { await runtime.close(); }
}

// example: registry
export async function registryResolve(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "keyword", providers: { keyword: provider } } });
  const selected = providers.resolve({ name: "kb" });
  return selected.search({ ...request, limit: 5 }); // Raw output, strategy is filled with "keyword".
}

// example: cancel
export async function cancelRetrieval(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers, defaults: { searchLimit: 5 } });
  const controller = new AbortController(); controller.abort();
  return retrieval.search(request, { searchLimit: 10 }, { signal: controller.signal });
}

// example: embedding
export async function embeddingApis(embedding: EmbeddingProvider, dimensions: number) {
  const direct = await embedding.embed({ contents: ["query text"], purpose: "query" });
  const documents = await embedContents(embedding, { contents: ["document A", "document B"], purpose: "document" }, { batchSize: 32, dimensions });
  validateVector(documents[0], dimensions); // Returns void; throws on invalid/empty/mismatched vectors.
  return { direct, documents };
}

// example: httpEmbedding
export async function httpEmbedding() {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const runtime = createDitto({ config });
  try {
    const embedding = createHttpEmbeddingProvider({ ...embeddingConfigFromEnv(process.env), sandbox: runtime.services.sandbox, timeoutMs: config.timeoutMs });
    return await embedContents(embedding, { contents: ["query text"], purpose: "query" }, {}, { defaults: config.retrieval });
  } finally { await runtime.close(); }
}

// example: vector
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

// example: text
export async function textSearch(backend: RetrievalSearchProvider) {
  return createTextSearchProvider(backend).search({ ...request, strategy: "keyword" });
}

// example: hybrid
export async function hybridSearch(vector: RetrievalSearchProvider, text: RetrievalSearchProvider) {
  const hybrid = createHybridSearchProvider({ candidateLimit: 50, rrfK: 60,
    branches: [{ provider: vector, strategy: "vector", weight: 1 }, { provider: text, strategy: "keyword", weight: 0.7 }],
  });
  return hybrid.search({ ...request, strategy: "hybrid" });
}

// example: rerank
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

// example: sql
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

// example: milvus
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

// example: memoryNative
export async function nativeMemoryInRetrieval(nativeSearch: MemorySearchProvider) {
  const provider = createMemoryRetrievalProvider(nativeSearch);
  const output = await provider.search(request);
  return mapMemoryCandidates(output); // content must be a complete MemoryItem, not just text.
}

// example: memoryNamespace
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

// example: memoryLocal
export async function localMemoryPipeline(store: MemoryStore, provider: RetrievalSearchProvider) {
  const search = createRetrievalMemorySearchProvider({ provider, target: { name: "kb" }, strategy: "vector", defaults: { searchLimit: 5 } });
  const runtime = createDitto({ workers: [createMemoryWorker({ store, search })] });
  try { return await runtime.invoke("MEMORY.SEARCH", { query: "agent memory", limit: 3 }); }
  finally { await runtime.close(); }
}

// example: memoryRemote
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

// example: memoryMap
export function mapTextCandidates(output: RetrievalSearchOutput) {
  return output.candidates.map(candidate => {
    if (!candidate.id) throw new Error("The application requires candidate ids");
    return { memory: { id: candidate.id, content: candidate.content }, ...(candidate.score === undefined ? {} : { score: candidate.score }) };
  }); // Use as mapOutput only when content is the application's complete memory content.
}

// example: scaffold
export function retrievalDescriptor(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers });
  return retrievalSearchNode.define("RETRIEVAL", input => retrieval.search(input));
}
