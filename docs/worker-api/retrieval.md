# RETRIEVAL Worker API (optional)

[简体中文](retrieval.zh-CN.md) · [Worker API](README.md)

RETRIEVAL v0.1 provides only `RETRIEVAL.SEARCH`: an optional execution boundary for relevance retrieval that needs independent resources, deployment or scaling. Core Workers remain INFER, CONTEXT, MEMORY and INTERACTION. Existing local/external MEMORY and CONTEXT providers need no extra service hop.

It ships as the separate optional npm package `@codesoul-co/ditto-retrieval`, with `@codesoul-co/ditto` as a peer dependency. Install both packages when retrieval is needed. Core's root and worker entry points do not export/load it. Import and register explicitly; YAML alone never starts a Worker. Applications decide when to deploy it; Core does not automatically start services based on load.

## Functional selection and parameter effects

`RETRIEVAL.SEARCH` returns relevant evidence candidates for documents, external knowledge bases, code indexes or memory search. It does not generate answers, write source stores or choose a corpus automatically. Loop composes retrieval, Context selection, inference and citation-checking Graphs for complete QA. Internal memory normally enters through MEMORY.SEARCH; external knowledge can call RETRIEVAL.SEARCH directly, reusing provider algorithms where appropriate.

### Request parameters determine scope and result size

| Parameter | Node impact | Worker/backend impact |
| --- | --- | --- |
| `query.content` | Text, vectors or structured queries with provider-defined semantics | Vector providers can search precomputed vectors or embed text first; text providers do not embed. Longer text may increase model cost without improving retrieval |
| `target.name` | Resolves a registered target provider | Selects corpus/backend bindings without inferring URLs, tables or connections. Unknown targets fail without switching stores |
| `target.namespace` / metadata | Passes scope and application metadata to the provider | Only implemented provider constraints take effect. Namespace is not authorization; adapters validate trusted identity and access scope |
| `strategy` | Chooses a registered vector/keyword/bm25/hybrid/custom strategy | Omission uses the registered default; hybrid does not create branches automatically. Scores are not confidence and cannot be added across algorithms |
| `filter` | Passes version, tenant, time or other constraints | Provider must enforce or reject them. Narrower scope may improve precision or exclude the only evidence; indexes affect performance |
| `limit` | Caps final candidates; default 10, range 1–10000 | Larger limits can increase recall, transfer, ranking and Context input. Not embedding batchSize or sampling topK |
| `options` | Passes provider-specific query controls | No universal automatic minScore/threshold protocol; configure and test the actual adapter |

The Node wrapper validates target, strategy, shapes and counts while preserving provider order. It does not automatically normalize scores, deduplicate or rerank; the following behaviors belong to explicitly composed optional providers.

### Provider settings determine pools and computation

| Parameter | Default / behavior | Adjustment tradeoff |
| --- | --- | --- |
| `embedding.batchSize` | Default 64, range 1–2048; embedContents executes bounded batches sequentially | Larger batches reduce request count while increasing payload, memory and failure scope, subject to service batch/token limits. Not concurrency |
| `embedding.dimensions` | Optional expected vector length | Validates output/index compatibility; does not truncate vectors or change HTTP request dimensions. Model/index dimension changes require compatible reindexing |
| vector `nativeEmbedding` / `embedding` | Chooses database-native embedding or an external provider, mutually exclusive | Native mode delegates text processing to the database; external mode adds model calls. Equal dimensions do not guarantee model compatibility |
| hybrid `candidateLimit` | Default 100; each branch uses at least max(request.limit,candidateLimit) | Expands coverage and backend/fusion work. A pool floor rather than a ceiling that ignores request.limit |
| hybrid branches / weight | Concurrent branch queries; positive weights default to 1 | More branches add backend requests; higher weight favors that branch without adding raw scores. Any branch failure fails the operation after accepted branches settle |
| hybrid `rrfK` | Default 60, positive integer; sum of weight/(rrfK+rank), rank starts at 1 | Smaller values emphasize leading rank differences; larger values reduce rank differences and make contributions across branches relatively more prominent. Not a candidate count |
| hybrid `key` | Defaults to source target plus ID/ref identity | Determines deduplication/fusion identity. Cross-source equivalents need shared mapping; missing IDs/refs require an explicit key |
| rerank `candidateLimit` | Default 100, never below final limit; retrieves a larger pool then reranks | Expands judge-visible coverage and scoring work. Reranking cannot recover evidence outside its search pool |
| `createCosineReranker(embedding)` | Embeds query and candidate content, then sorts cosine similarity | More candidates require more embedding work. Not a cross-encoder; inject another RerankProvider for other scoring models |

Final limit resolves request → Worker defaults → Runtime YAML → 10. Provider numbers resolve constructor options → matching Worker-default field → YAML → built-in value. A provider with constructor candidateLimit does not change that value from YAML; omit fixed options and explicitly supply configuration for centralized tuning.

### Resource usage and a tradeoff example

Worker concurrency bounds SEARCH entry calls; one hybrid search still queries several branches concurrently. One entry slot is not one database request. Match concurrency to branches, pools and embedding/rerank quotas. Cancellation is cooperative, and remote HTTP cancellation does not guarantee server termination.

With final limit=8 and two hybrid branches each using candidateLimit=100, each reads at most 100 candidates before fusion returns at most eight. An outer reranker with candidateLimit=50 requests at least 50 fused results before selecting eight; each hybrid branch's own floor of 100 still applies. Context may subsequently select only five. Larger search pools do not put every document into the model. Evaluate backend recall, candidate ranking, evidence reaching Context, latency and actual resource usage separately.

See [provider/database wiring](retrieval-providers.md). SEARCH does not create indexes or synchronize memory writes automatically. When changing embedding models, data scope or indexes, check existing data compatibility.

## Enable explicitly

```ts
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import { createRetrievalWorker, RetrievalTargetRegistry, type RetrievalSearchProvider } from "@codesoul-co/ditto-retrieval";

function startRetrieval(kbProvider: RetrievalSearchProvider, codeProvider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({
    "company-kb": { defaultStrategy: "hybrid", providers: { hybrid: kbProvider } },
    "code-index": { defaultStrategy: "bm25", providers: { bm25: codeProvider } },
  });
  return createDitto({
    config: loadRuntimeConfigFile("ditto.yaml", process.env),
    workers: [createRetrievalWorker({ providers, concurrency: 8 })],
  });
}
```

Wrap the existing low-level MEMORY/CONTEXT retrieval function in RetrievalSearchProvider, keeping its backend and algorithm; do not route it back to the MEMORY.SEARCH already delegating to it.

The optional module supplies batched/HTTP embedding, vector and database-native full-text adapters, weighted RRF fusion and replaceable reranking. Reuse existing database search plugins or inject SQL/Milvus clients; no drivers or database lifecycle are included. Graph/custom strategies use their own SearchProvider. See [complete provider API and database wiring](retrieval-providers.md). There are no EMBED/RANK placeholders or mandatory pipeline stages.

## Contracts

```ts
interface RetrievalQuery { content: unknown; metadata?: Record<string, unknown>; }
interface RetrievalTarget {
  name: string;
  type?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}
interface RetrievalCandidate {
  id?: string;
  content: unknown;
  score?: number;
  source?: { target?: string; ref?: string };
  metadata?: Record<string, unknown>;
}
interface RetrievalSearchInput {
  query: RetrievalQuery;
  target: RetrievalTarget;
  strategy?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  options?: Record<string, unknown>;
}
interface RetrievalSearchOutput {
  candidates: readonly RetrievalCandidate[];
  strategy?: string;
  target: RetrievalTarget;
  metadata?: Record<string, unknown>;
}
interface RetrievalSearchProvider {
  search(input: RetrievalSearchInput, context?: RetrievalExecutionContext): Promise<RetrievalSearchOutput>;
}
interface RetrievalProviderRegistry {
  resolve(target: RetrievalTarget, strategy?: string): RetrievalSearchProvider;
}
interface RetrievalResources { readonly providers: RetrievalProviderRegistry; }
interface RetrievalOptions extends RetrievalResources {
  readonly defaults?: RetrievalDefaults;
  readonly concurrency?: number;
}
```

`createRetrievalWorker(options)` returns a WorkerDefinition exposing SEARCH. `createRetrieval(options).search(input, runtimeDefaults?, context?)` is the standalone SDK; defaults include searchLimit and nested embedding/hybrid/rerank settings, and context accepts a local AbortSignal. See [provider configuration](retrieval-providers.md#http-embedding-and-root-configuration). SDK calls do not schedule concurrency. Runtime calls use `runtime.invoke("RETRIEVAL.SEARCH", input)` or `ctx.invoke`, returning shared `NodeResult<RetrievalSearchOutput>` with executionId, node, status and output/error. `retrievalSearchNode` exports the semantic scaffold. The optional entry augments NodeContractMap without adding this contract to Core's default exports.

query.content must exist but can contain text, vectors or structured data. Providers validate its meaning. The caller must supply a target; no automatic corpus selection. Identifier fields are nonempty strings, metadata/filter/options are objects, and limit is an integer in 1–10000. HTTP requires application-agreed JSON representations; local calls need not stringify content. Targets are logical names, not connection descriptors. Credentials, collection names and backend URLs belong inside providers.

```ts
const result = await runtime.invoke("RETRIEVAL.SEARCH", {
  query: { content: "agent memory migration" },
  target: { name: "company-kb" },
  strategy: "hybrid",
  filter: { year: { gte: 2024 } },
  limit: 20,
});
if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
const candidates = result.output.candidates;
```

## Target bindings and output

```ts
const providers = new RetrievalTargetRegistry({
  "agent-memory": {
    defaultStrategy: "vector",
    providers: { vector: vectorProvider, hybrid: hybridProvider },
  },
});
```

The built-in registry snapshots target-to-strategy maps at startup and uses Map lookups. A provider may serve multiple strategies. Missing strategies use the target's registered default, which is passed into the provider and included in output. Unknown targets/strategies fail without fallback; the default must be registered. `rag` is rejected as a strategy. vector, keyword, bm25, hybrid, graph and custom names remain strategies/providers, not nodes.

The registry resolves target.name; type/namespace/metadata pass through. Namespace is not an authorization credential. Providers or custom RetrievalProviderRegistry implementations must enforce tenant/namespace permissions. Custom registries also define default-strategy behavior. There is no network discovery, dynamic database creation or hot registration.

Providers return raw RetrievalSearchOutput, not another NodeResult. The Worker checks candidate shapes, required content, optional ID/source/metadata, finite scores and result limits. Returned target name/type/namespace must match the request, as must an explicitly selected strategy. Invalid responses are not silently truncated or accepted as empty success.

Normalization uses the requested logical target and selected strategy, preserving candidate order, scores, references and metadata. It does not rerank, rescale, deduplicate or invent IDs. IDs may be absent or repeated across sources. Empty results are `{ candidates: [], target, strategy? }`.

## Optional MEMORY bridge

```ts
import { createMemoryWorker } from "@codesoul-co/ditto";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";

const search = new RemoteRetrievalSearchProvider({
  runtime, target: { name: "agent-memory" },
  mapOutput(output) {
    return output.candidates.map(candidate => {
      // Application convention: candidate.id is a Memory ID; content is complete memory content.
      if (!candidate.id) throw new Error("Missing Memory ID");
      return {
        memory: { id: candidate.id, content: candidate.content,
          ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }) },
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
        metadata: { source: candidate.source },
      };
    });
  },
});
runtime.register(createMemoryWorker({ store: applicationMemoryStore, search }));
```

RemoteRetrievalSearchOptions requires a fixed target and accepts optional `runtime?: Pick<RuntimeClient, "invoke">`. mapOutput is optional when candidate.content contains a complete MemoryItem; otherwise provide an explicit mapper. The mapper receives the complete RetrievalSearchOutput and may return MemorySearchOutput synchronously or asynchronously, enabling batch hydration. The adapter does not infer memory IDs, open storage connections or perform per-candidate SQL GETs.

It maps MemorySearchInput.query to query.content and forwards strategy/filter/limit/options. Failed SEARCH results never reach the mapper. It invokes the public node through Runtime and imports only MEMORY types, preserving MEMORY.SEARCH's API. The name also works with a local registered retrieval Worker. Without it, continue injecting the existing MemorySearchProvider.

MEMORY's existing error boundary converts adapter failures to MEMORY_BACKEND_ERROR. Direct RETRIEVAL calls expose the more specific codes below. Remote error text is not forwarded to MEMORY callers.

## Deployment and scaling

Run a Runtime containing only RETRIEVAL in a separate process and mount existing HTTP transport:

```ts
import { createServer } from "node:http";
import { createWorkerHttpHandler } from "@codesoul-co/ditto";
const token = process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN;
if (!token) throw new Error("Missing transport token");
const server = createServer(createWorkerHttpHandler(retrievalRuntime, { token }));
server.listen(8080, "127.0.0.1");
// Share retrievalRuntime.workers()[0].address through deployment configuration.
```

The client installs a transport and registers the address:

```ts
import { createHttpTransport } from "@codesoul-co/ditto";
const transport = createHttpTransport({ id: "retrieval-service", url, token });
const runtime = createDitto({ transports: [transport] });
runtime.registerRemote({ address, transportId: transport.id, capabilities: ["RETRIEVAL.SEARCH"] });
```

Install a transport for each service endpoint and register additional replicas. See [Worker communication](../worker-communication.md). Existing routing prefers local, same-host, then remote capacity, rotating equally eligible replicas. concurrency limits accepted entry calls per replica. Saturated local pools reject immediately; remote capacity is enforced by receivers. No new queue, retry loop or machine autoscaler is added.

Routing is by node capability, not target. Replicas in one caller's pool must support the pool's same logical targets/strategies. Each target may connect to a different backend cluster within each registry. Incompatible dedicated pools require separate application Runtime/transport bindings; the router does not infer target affinity.

Same-process replicas share an event loop and do not add CPU cores. CPU/GPU isolation and more cores require separate processes/hosts. This boundary enables independent scaling; it does not guarantee faster individual searches.

Applications own registry/provider connections. Reusing a definition shares injected objects; create separate definitions/providers for isolated connections or model handles. Runtime shutdown stops routing and drains accepted work; applications then close provider resources and HTTP servers. RETRIEVAL owns no corpus or durable business state.

## Configuration and errors

```yaml
workers:
  retrieval:
    searchLimit: 10
    embedding:
      batchSize: 64
    hybrid:
      candidateLimit: 100
      rrfK: 60
    rerank:
      candidateLimit: 100
```

Root YAML normalizes to config.retrieval. Precedence is request limit > options.defaults.searchLimit > Runtime YAML > built-in 10. Standalone SDKs may pass `defaults: config.retrieval`. Configuration loads at startup with no file I/O on the request path. Backend addresses/credentials remain application env configuration. The optional HTTP embedding factory explicitly reads the grouped RETRIEVAL embedding env keys; see [provider configuration](retrieval-providers.md#http-embedding-and-root-configuration).

| Code | Meaning |
| --- | --- |
| RETRIEVAL_INVALID_INPUT | Invalid public request |
| RETRIEVAL_TARGET_NOT_FOUND | Unregistered target |
| RETRIEVAL_STRATEGY_UNSUPPORTED | Unregistered target strategy or rag |
| RETRIEVAL_PROVIDER_UNAVAILABLE | Registry/provider lacks callable methods |
| RETRIEVAL_INVALID_BACKEND_OUTPUT | Invalid shape, target, strategy or count |
| RETRIEVAL_BACKEND_ERROR | Unclassified exception, original details hidden |
| RETRIEVAL_INVALID_EMBEDDING | Invalid vector count, index, values or dimensions |
| RETRIEVAL_CANCELLED | Local SDK signal aborted; status is cancelled |
| RETRIEVAL_TIMEOUT | Explicit provider timeout; NodeResult.status is timeout |
| RETRIEVAL_PERMISSION_DENIED | Explicit provider/custom-registry denial |

Providers can throw `new RetrievalError(code, safeMessage)`; its message is public and must exclude private connection details. Other exceptions are sanitized. Local SDK cancellation is forwarded cooperatively through provider context; HTTP embedding enforces its own timeout. Other backend deadlines/cancellation remain provider-owned. There is no timeout race that releases concurrency while uncooperative work continues. HTTP client timeout stops waiting, not necessarily server execution. Existing Runtime routing/transport failures reject the Promise rather than becoming empty success.

## Graph boundary

RAG is an application composition: RETRIEVAL.SEARCH → explicit candidate mapping → CONTEXT.UPDATE → INFER. SEARCH does not write Context/Memory, call INFER/Tools or rewrite the query. Candidate-to-Context mapping belongs to the caller; content is not assumed to be a Document or Message.

## Examples for each API

Complete source: [examples/retrieval.ts](examples/retrieval.ts). The functions below share its imports; importing the file executes no examples. Applications supply database, model, or MCP resources. Choose the function you need; writes, deletes, and model calls perform real operations when invoked.

```ts
import { createDitto, createMemoryWorker, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import type { MemorySearchProvider, MemoryStore, MemoryItem } from "@codesoul-co/ditto/worker/memory";
import {
  createRetrieval, createRetrievalWorker, RetrievalTargetRegistry, RetrievalError, retrievalSearchNode,
  embedContents, validateVector, createVectorSearchProvider, createTextSearchProvider,
  createHybridSearchProvider, createCosineReranker, rerankCandidates, createRerankSearchProvider,
  createHttpEmbeddingProvider, embeddingConfigFromEnv, createSqlSearchProvider, createMilvusSearchProvider,
  type RetrievalSearchProvider, type RetrievalSearchInput, type RetrievalSearchOutput,
  type EmbeddingProvider, type RerankProvider, type SqlSearchOptions, type MilvusSearchOptions,
} from "@codesoul-co/ditto-retrieval";
import {
  createMemoryRetrievalProvider, createRetrievalMemorySearchProvider,
  RemoteRetrievalSearchProvider, mapMemoryCandidates,
} from "@codesoul-co/ditto-retrieval/adapters/memory";

export const request: RetrievalSearchInput = { query: { content: "agent memory" }, target: { name: "kb" }, limit: 5 };
```

The shared request uses query.content="agent memory", target.name="kb", and limit=5. Supply a provider supporting that query contract.

### createRetrieval / createRetrievalWorker: opt-in setup

providers is required. createRetrieval returns a direct SDK with one search method; createRetrievalWorker exposes only SEARCH. concurrency applies to the Worker only.

```ts
export function setupRetrieval(provider: RetrievalSearchProvider) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "vector", providers: { vector: provider } } });
  const runtime = createDitto({ config, workers: [createRetrievalWorker({ providers, concurrency: 4 })] });
  const retrieval = createRetrieval({ providers, defaults: config.retrieval });
  return { runtime, retrieval };
}
```

### retrieval.search / RETRIEVAL.SEARCH: candidates

Compares direct SDK and Runtime calls. No matches means successful output with candidates: [] and target/strategy preserved. Candidate ids remain optional.

```ts
export async function retrievalSearch(provider: RetrievalSearchProvider) {
  const { runtime, retrieval } = setupRetrieval(provider);
  try {
    const local = await retrieval.search(request);
    const routed = await runtime.invoke("RETRIEVAL.SEARCH", request);
    if (routed.status !== "success" || !routed.output) throw new Error(routed.error?.code ?? routed.status);
    return { local, candidates: routed.output.candidates, target: routed.output.target };
  } finally { await runtime.close(); }
}
```

### RetrievalTargetRegistry.resolve: provider selection

resolve(target, strategy?) uses the target default when strategy is omitted. The selected wrapper forwards and fills strategy. Direct provider calls return raw output and throw errors.

```ts
export async function registryResolve(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "keyword", providers: { keyword: provider } } });
  const selected = providers.resolve({ name: "kb" });
  return selected.search({ ...request, limit: 5 }); // Raw output, strategy is filled with "keyword".
}
```

### search runtimeDefaults / context arguments

Full signature: search(input, runtimeDefaults = {}, context = {}). Signal belongs in the third argument. The second argument supplies fallback defaults; SDK-computed defaults replace context.defaults. There is no automatic timeoutMs option.

```ts
export async function cancelRetrieval(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers, defaults: { searchLimit: 5 } });
  const controller = new AbortController(); controller.abort();
  return retrieval.search(request, { searchLimit: 10 }, { signal: controller.signal });
}
```

### Node descriptor type / define

`retrievalSearchNode.type` is RETRIEVAL.SEARCH. `.define(workerType, handler)` fixes identity and types without registering a Worker. The example reuses SDK validation and NodeResult; normally use createRetrievalWorker.

```ts
export function retrievalDescriptor(provider: RetrievalSearchProvider) {
  const providers = new RetrievalTargetRegistry({ kb: { defaultStrategy: "custom", providers: { custom: provider } } });
  const retrieval = createRetrieval({ providers });
  return retrievalSearchNode.define("RETRIEVAL", input => retrieval.search(input));
}
```

## Compose with CONTEXT

CONTEXT.SELECT ragStrategy can reuse a SearchProvider or delegate to RETRIEVAL.SEARCH through Runtime. Check delegated NodeResult, map candidates to ContextItem[], and explicitly UPDATE if persistence is needed. [Complete CONTEXT API and examples](context.md)。

```ts
export function remoteContextRetrieval(runtime: import("@codesoul-co/ditto").RuntimeClient, target: RetrievalTarget) {
  return contextRetrieval({ async search(input) {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", input);
    if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
    return result.output;
  } }, target);
}
```

[Complete imports and source](examples/context.ts).

## Worker call context

The built-in RETRIEVAL Worker forwards the current Runtime signal in the provider's RetrievalExecutionContext; embedding, database, fusion and reranking adapters propagate it. Example: `await runtime.invoke("RETRIEVAL.SEARCH", { query: { content: "question" }, target: { name: "docs" } }, { signal: AbortSignal.timeout(5000) })`. MEMORY and CONTEXT delegation adapters inherit their parent invocation context; see the [Context provider bridge](retrieval-providers.md#context-retrieval-adapter). HTTP/IPC cancellation does not imply that a server-side database operation was canceled.

For `RemoteRetrievalSearchProvider`, omit construction-time runtime inside a MEMORY Worker to inherit its invocation-bound Runtime. An explicit runtime always takes precedence; standalone SDK delegation requires it. Example: `new RemoteRetrievalSearchProvider({ target: { name: "memories" } })` for Worker-owned delegation.

For complete Agent tasks with persistence and citations, see [information retrieval and search workflows](search-workflows.md).
