# MEMORY Worker API

[简体中文](memory.zh-CN.md) · [Worker API](README.md)

MEMORY implements GET, QUERY, SEARCH, WRITE, UPDATE and DELETE as stable access primitives over externally supplied storage/search plugins. Ditto handles routing, validation, result envelopes and injection. Applications own database clients, connections, schema, indexes and migrations. Core includes no SQL statements, MySQL/PostgreSQL drivers, Milvus client or database deployment.

## Functional selection and parameter effects

| Node | Suitable tasks | How parameters affect results |
| --- | --- | --- |
| `MEMORY.GET` | Restore a known checkpoint, preference or handoff | Exact ids/keys union with deduplication; omits missing records without relevance search |
| `MEMORY.QUERY` | Enumerate records by task, status, time or other structure | filter narrows the set, orderBy selects order, limit/cursor paginate; Store defines semantics |
| `MEMORY.SEARCH` | Find durable memory relevant to the current question | query, strategy, filter, limit and options go to the search plugin; not fuzzy GET |
| `MEMORY.WRITE` | Save new facts, stage artifacts or task-state records | memories key/content/metadata create records; Store defines IDs and key conflicts |
| `MEMORY.UPDATE` | Correct known content or metadata | Updates supplied fields by ID; omitted fields remain, supplied metadata replaces the whole object |
| `MEMORY.DELETE` | Remove confirmed expired, withdrawn or unwanted records | Deduplicates IDs and reports actual removals; does not clear other Worker caches or loaded Context |

### Query, ordering and write tradeoffs

| Parameter / design | Behavioral effect | Worker/backend impact |
| --- | --- | --- |
| QUERY / SEARCH `limit` | Larger values expand a page or relevant-result set and may admit weaker matches | More backend reads, transfer and downstream Context processing; not a total-history limit |
| QUERY `cursor` / `orderBy` | Stable ordering and cursors support pagination; changing order can change pages | Plugin-defined cursor encoding is not freely reusable across queries/backends. Unstable order can skip or repeat items |
| QUERY / SEARCH `filter` | Restricts tenant, task, time or document-version scope | Plugin defines support and indexes. Enforce access scope from trusted identity in application/adapters; caller filters are not permission evidence |
| SEARCH `strategy` / `query` | Selects vector, keyword, hybrid or custom algorithms; queries may be text, vectors or structured objects | Requires plugin support; MEMORY neither embeds automatically nor creates a vector index on writes |
| SEARCH `options` / `score` | options tunes plugin behavior; score expresses plugin relevance | No universal score-above-0.8 trust rule. Evaluate scale, direction and thresholds with the algorithm and corpus |
| WRITE `key` / `metadata` | Stable keys support exact recovery; metadata can hold provenance, versions and task identity | Keys do not automatically mean upsert or idempotency. Store constraints/transactions must prevent duplicate retry writes |
| UPDATE `content` / `metadata` | Omission retains values; content=null explicitly changes content, metadata={} clears metadata | Supplying one metadata field replaces the object. Merge explicitly in trusted application/adapters and handle concurrent changes |
| WRITE / UPDATE batch size | Multiple objects per call can reduce application round trips | Larger payloads and transactions; Ditto does not guarantee atomic batches. Store must specify transactions, partial failures and compensation |

Limits are integers in 1–10000. Defaults are QUERY=100 and SEARCH=10, resolving request limit → constructor defaults → Runtime YAML → built-in default. Constructor defaults are fallbacks rather than hard ceilings; a request can raise its limit within the contract. Standalone SDKs need explicit configuration.

WRITE/UPDATE do not invoke models, validate facts, consolidate summaries, embed or update Context. Separate source stores and vector indexes require application-managed update/delete consistency. Empty batches return locally. Verify returned records, stable keys and actual persistence rather than accepting a model statement that data was saved.

### Worker resources and recovery

Worker concurrency bounds entry calls without creating database pools or controlling Store-internal fan-out. Higher concurrency can improve throughput or produce pool waits, lock contention and rate limits; match actual plugin capacity. Forward cancellation to drivers; stopping a wait does not prove a write rolled back. Applications define consistency boundaries across patches, checkpoints and external effects.

Use GET with a known key to restore a stage, QUERY with explicit conditions to list unfinished tasks, and SEARCH for similar prior experience. Records do not automatically become model messages. Check permissions, provenance and versions, then map into CONTEXT while retaining record IDs for verification.

## Setup

```ts
import { createDitto, createMemory, createMemoryWorker, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import type { MemoryResources } from "@codesoul-co/ditto/worker/memory";

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

Supply resources from an application-owned adapter package. `MemoryOptions` contains `{ store, search?, defaults?, concurrency? }`; defaults are `{ queryLimit?, searchLimit? }`. `createMemory` exposes `execute(node, input, options?)` and `get/query/search/write/update/delete(input, options?)`, all returning the same NodeResult as Runtime invocation. `createMemoryWorker` registers all six nodes for Graphs, `ctx.invoke` and existing HTTP transport. Concurrency limits apply only to Runtime Worker entry calls; the standalone SDK does not schedule calls.

## Replaceable plugin ports

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

| Deployment | store | search |
| --- | --- | --- |
| MySQL / PostgreSQL | External relational adapter | Its supported search implementation or a separate search plugin |
| Standalone Milvus | Milvus adapter implementing record CRUD and structured query | The same Milvus adapter |
| Mixed backends | Any MemoryStore | Any MemorySearchProvider |

When one database plugin implements both ports, use `createMemoryWorker({ store: backend })`: search defaults to store.search. An explicit search overrides only retrieval; CRUD remains on store. CRUD-only plugins need no dummy search; SEARCH returns SEARCH_UNAVAILABLE if neither search implementation is available. Milvus does not require SQL. A separate search plugin must return complete MemoryItems and manage its own source/index mapping, consistency and permissions; Ditto performs no implicit SQL lookup.

No base class or registry is required. Plugins own dialects/expressions, parameterization, serialization, tenant/namespace isolation, transactions, conflict detection, timeouts and cleanup. Registering the same Worker definition shares the injected plugin objects; create separate plugins/definitions when isolation is needed. Runtime shutdown drains accepted operations but does not close application-owned connections.


### Embedding and independent execution

MEMORY unifies common database access contracts while the plugin executes the corresponding SDK. It does not implement an ORM or copy the database query engine. Native full-text, vector, graph and other retrieval methods can use the same plugin's search.

| Scenario | Execution |
| --- | --- |
| Database-native embedding/search | `createMemoryWorker({ store: database })` passes text to the database SDK without duplicate external embedding. |
| Database expects external vectors | The plugin injects a cloud or local EmbeddingProvider before SDK search; it may reuse the optional vector Provider. |
| Separate search system/local pipeline | Inject search explicitly; storage and search can use different backends. |
| Independent CPU/GPU, capacity or deployment needed | Register the same low-level pipeline in RETRIEVAL and inject RemoteRetrievalSearchProvider into MEMORY. |

Compute location and storage location are independent. A cloud database or local model does not require a RETRIEVAL Worker. Cloud SDKs and local model SDKs can implement Providers directly; HTTP is just one transport. See [cloud and local providers](retrieval-providers.md#cloud-and-local-providers).

For document embeddings, native database functions may handle SDK writes. Otherwise the storage plugin's write/update explicitly calls an external provider and owns record/vector consistency. MEMORY does not force a model call on every WRITE. The schema-aware plugin decides whether metadata-only changes need re-embedding, how to batch, and how to maintain indexes.

## Shared data and envelope

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

NodeResult is shared with INFER through `@codesoul-co/ditto/contracts`. Plugin methods return raw outputs; MEMORY wraps them once. This implementation emits success/failed, with no independent cancellation/deadline mechanism. Plugins enforce backend deadlines; failure does not imply rollback.

Content is not coerced to a Message, string or vector. Local SDK calls can carry application objects; HTTP and persistence require an agreed serializable representation. Plugins define reserved metadata namespaces. IDs and keys are nonempty strings. Scores must be finite when supplied; scale and ranking direction belong to the search plugin. Ditto preserves search order.

## Node contracts

| Node | Raw output | Dependency |
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
await runtime.invoke("MEMORY.GET", { ids: ["m1"], keys: ["preference"] });
```

Supply at least one selector; both form a union. Ditto deduplicates selectors, ignores missing records and returns requested ID order followed by key order, emitting each record once. Empty selectors return an empty array without invoking storage. Plugins must guarantee key uniqueness within their scope. GET performs no relevance search.

### QUERY

```ts
interface MemoryQueryInput {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
}
await runtime.invoke("MEMORY.QUERY", {
  filter: { tenant: "project-a", state: "active" },
  orderBy: [{ field: "createdAt", direction: "desc" }], limit: 20,
});
```

Structured, deterministic filtering. The plugin defines its filter DSL, fields, default ordering and opaque cursor encoding; Ditto forwards these without compiling SQL or Milvus expressions. Cursor/nextCursor must be nonempty strings. Plugins provide stable ordering, omit nextCursor on the final page, respect limit and explicitly reject unsupported filters/order fields. Switching plugins may require adapting application query semantics.

### SEARCH

```ts
interface MemorySearchInput {
  query: unknown;
  strategy?: string;
  filter?: Record<string, unknown>;
  limit?: number;
  options?: Record<string, unknown>;
}
await runtime.invoke("MEMORY.SEARCH", {
  query: { vector: [0.1, 0.2, 0.3] }, strategy: "vector",
  filter: { tenant: "project-a" }, limit: 10, options: { metric: "COSINE" },
});
```

The query property is required; plugins validate its value. Example fields describe an application/plugin agreement, not built-in Milvus parameters. Strategy names are open (vector, keyword, bm25, hybrid, graph, etc.); plugins reject unsupported strategies explicitly. No automatic embedding, fixed EMBED → RETRIEVE → RANK pipeline or mandatory Retrieval Worker. Results include full records and optional score/retrieval metadata, in plugin order.

### WRITE

```ts
interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
await runtime.invoke("MEMORY.WRITE", {
  memories: [{ key: "preference", content: { language: "en" }, metadata: { source: "user" } }],
});
```

Creates records; plugins allocate IDs and declare key conflict policy. Empty arrays return locally. Success means the source store has committed and returned one full record per draft; conflicts must not silently drop inputs. No model calls, embedding, consolidation or Context update is triggered.

### UPDATE

```ts
interface MemoryUpdateEntry { id: string; content?: unknown; metadata?: Record<string, unknown>; }
interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
await runtime.invoke("MEMORY.UPDATE", { memories: [{ id: "m1", metadata: { source: "corrected" } }] });
```

Field-level partial update: omitted content/metadata retain their values; supplied metadata replaces the whole metadata object (`{}` clears it). Content presence determines whether to update it; null is valid. Identity and key remain unchanged. Plugins fail for missing targets rather than upserting. Duplicate IDs, empty patches and supplied key fields fail before a plugin call. Empty batches return locally. Success must return each requested ID exactly once as a full record. Plugins own conflict checks and concurrency guarantees; Ditto neither pre-reads records nor adds version/re-embedding workflows.

### DELETE

```ts
interface MemoryDeleteInput { ids: readonly string[]; }
interface MemoryDeleteOutput { deleted: readonly string[]; }
await runtime.invoke("MEMORY.DELETE", { ids: ["m1", "m1"] });
```

Ditto deduplicates IDs; empty input returns `{ deleted: [] }` locally. Plugins ignore absent records and return only IDs actually deleted in this call, without duplicates or unrelated IDs. Repeated deletion returns an empty array. Soft/hard deletion is a plugin policy; ordinary reads must exclude deleted records. Eviction selection, expiry and deprioritization remain application policy.

## Validation and errors

Limits are integers in 1–10000. Nodes validate arrays, required properties, identifiers, object fields and ordering directions before calling plugins. Responses are checked for record shape, duplicate IDs, finite scores, cursors, result counts, update IDs and deletion scope.

| Code | Meaning |
| --- | --- |
| INVALID_INPUT | Public input contract violation; plugin not called |
| SEARCH_UNAVAILABLE | Neither an explicit search nor store.search is available; CRUD remains usable |
| UNKNOWN_NODE | Unknown node passed to SDK execute |
| INVALID_BACKEND_OUTPUT | Invalid plugin result; completed mutations are not rolled back |
| MEMORY_BACKEND_ERROR | Unclassified backend exception; raw error/credentials are not exposed |
| Plugin-defined | `new MemoryError(code, safeMessage)`, e.g. NOT_FOUND, CONFLICT, UNSUPPORTED_STRATEGY |

MemoryError messages are public: plugins must sanitize them. Plugins declare batch atomicity or partial-commit semantics. Ditto supplies no automatic retries, compensation or assurance that failed calls made no changes. Graph bind functions must check status before consuming output.

## Configuration

```yaml
workers:
  memory:
    queryLimit: 100
    searchLimit: 10
```

Root YAML is loaded as `config.memory`. Per-field precedence: request limit > MemoryOptions.defaults > Runtime YAML > built-in QUERY 100 / SEARCH 10. Standalone SDKs opt in with `defaults: config.memory`. Configuration is snapshotted; requests do not read files.

External plugins read database URLs, credentials and connection settings from application env. Core adds no unused database env/YAML placeholders. Applications may group plugin variables under `DITTO_WORKER_MEMORY_<PLUGIN>_*`, but Core does not parse that prefix.

## Graph and Context boundaries

MEMORY.SEARCH returns NodeResult; the Graph checks success and maps unknown content to CONTEXT.UPDATE ingress. Applications resolve Skill content for CONTEXT.LOAD/UPDATE. For cached state, replace UPDATE context with scope.

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

[Complete CONTEXT API](context.md)

## Optional independent retrieval service

Ordinary MemorySearchProviders remain unchanged. When independent retrieval resources are needed, explicitly import RemoteRetrievalSearchProvider from `@codesoul-co/ditto-retrieval/adapters/memory`, supplying a fixed target and, where needed, batch mapOutput. It delegates MEMORY.SEARCH to RETRIEVAL.SEARCH without changing the caller contract. MEMORY neither imports nor starts the extension. See [integration and deployment](retrieval.md).

The same storage plugin/connection can also supply native search. Optional helpers support both directions: createMemoryRetrievalProvider wraps that native search for RETRIEVAL; createRetrievalMemorySearchProvider runs an embedding/search/fusion/rerank pipeline directly inside MEMORY without starting another Worker. Remote mapping is optional when candidates contain complete MemoryItems. See [database and embedding wiring](retrieval-providers.md). Embedding during SEARCH does not make WRITE automatically index or synchronize vectors.

## Examples for each API

Complete source: [examples/memory.ts](examples/memory.ts). The functions below share its imports; importing the file executes no examples. Applications supply database, model, or MCP resources. Choose the function you need; writes, deletes, and model calls perform real operations when invoked.

```ts
import { createDitto, graph, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import {
  createMemory, createMemoryWorker, MemoryError, memoryGetNode,
  type MemoryResources, type MemoryStore, type MemorySearchProvider,
} from "@codesoul-co/ditto/worker/memory";
```

### createMemory / createMemoryWorker: setup

Both factories accept MemoryOptions. The SDK calls plugins directly; the Worker participates in routing. Explicit search overrides store.search. Neither factory closes database connections.

```ts
export function setupMemory(resources: MemoryResources) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const worker = createMemoryWorker({ ...resources, concurrency: 16 });
  const runtime = createDitto({ config, workers: [worker] });
  const memory = createMemory({ ...resources, defaults: config.memory });
  return { runtime, memory };
}
```

### memory.get / MEMORY.GET: exact reads

Successful output is a MemoryItem array, e.g. `[{ id: "m1", key: "preference", content: { language: "zh-CN" } }]`. Missing records are omitted.

```ts
export async function getMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.get({ ids: ["m1", "m1"], keys: ["preference"] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(item => ({ id: item.id, content: item.content }));
}
```

### memory.query / MEMORY.QUERY: pagination

Output is `{ items: [...], nextCursor?: string }`. Keep filters, ordering, and scope unchanged between pages. This example reads up to two pages; supported sort fields belong to the plugin.

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

### memory.search / MEMORY.SEARCH: relevance search

Output is `[{ memory: { id, content, ... }, score?, metadata? }]`. This example uses the plugin default strategy; explicit vector/keyword strategies must be supported by that plugin.

```ts
export async function searchMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.search({ query: "preferred language", limit: 5 });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.map(hit => ({ id: hit.memory.id, content: hit.memory.content, score: hit.score }));
}
```

### memory.write / MEMORY.WRITE: create

Creates preference and returns the database-assigned id. The output record count must equal the input count. The plugin defines duplicate-key, transaction, and idempotency behavior; rerunning may conflict.

```ts
export async function writeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  const result = await memory.write({ memories: [{ key: "preference", content: { language: "zh-CN" }, metadata: { source: "user" } }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!.id; // Allocated by the storage plugin.
}
```

### memory.update / MEMORY.UPDATE: partial updates

Pass the id returned by WRITE. This replaces content and clears metadata. Omit content for a metadata-only update; omitted fields are unchanged and key cannot be updated.

```ts
export async function updateMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.update({ memories: [{ id, content: { language: "en" }, metadata: {} }] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output[0]!; // metadata is replaced, not merged; key is unchanged.
}
```

### memory.delete / MEMORY.DELETE: delete

Returns `{ deleted: ["m1"] }` or `{ deleted: [] }`. Inspect output.deleted to determine which records were actually deleted.

```ts
export async function deleteMemory(resources: MemoryResources, id: string) {
  const memory = createMemory(resources);
  const result = await memory.delete({ ids: [id, id] });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output.deleted; // A missing id is not reported as deleted.
}
```

### memory.execute: generic SDK entry

Signature: `execute<N extends MemoryNode>(node, input, defaults?: MemoryDefaults)`. The third argument provides fallback defaults below factory defaults. All six convenience methods share this executor.

```ts
export async function executeMemory(resources: MemoryResources) {
  const memory = createMemory(resources);
  return memory.execute("MEMORY.QUERY", { limit: 10 });
}
```

### MemoryStore / MemorySearchProvider: adapter ports

Adapters return raw Output, not NodeResult. This demonstrates preserving the receiver. database is an application adapter implementing Memory contracts, not a raw SQL/Milvus SDK; SDK mapping, parameterized queries, and transactions belong inside it.

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

### MemoryError and failures

Use `new MemoryError(code, safeMessage)` for public failures. Invalid query input returns INVALID_INPUT before plugin invocation. Unclassified backend errors become MEMORY_BACKEND_ERROR; do not treat failures as empty results.

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

### Graph and shutdown

Place MEMORY nodes in application Graphs. Drain Runtime before closing database connections. Map MemoryItem.content explicitly before feeding INFER.

```ts
export async function memoryGraph(resources: MemoryResources) {
  const runtime = createDitto({ workers: [createMemoryWorker(resources)] });
  const plan = graph<string>("read-memory")
    .node("memory", "MEMORY.GET", [], id => ({ ids: [id] }));
  try { return await runtime.run(plan, "m1"); }
  finally { await runtime.close(); } // Close the application's database pool afterwards.
}
```

### Node descriptor type / define

The six descriptors are memoryGetNode, memoryQueryNode, memorySearchNode, memoryWriteNode, memoryUpdateNode, and memoryDeleteNode. `.type` identifies the Node; `.define(workerType, handler)` supplies a replacement. Prefer createMemoryWorker; replacement handlers own NodeResult and validation. This example returns an explicit failure.

```ts
export const customGet = memoryGetNode.define("MEMORY", async () => ({
  executionId: "example-call", node: "MEMORY.GET", status: "failed",
  error: { code: "NOT_CONFIGURED", message: "Configure the application storage adapter" },
}));
```

Runnable database integration examples: [examples/worker](examples/integrations/README.md), including SDK installation, env settings, invocation and cleanup.

## Cancellation and database SDKs

get/query/search/write/update/delete accept optional `MemoryCallOptions` as the second argument: `{ signal?: AbortSignal, runtime?: Pick<RuntimeClient, "invoke"> }`. execute accepts MemoryDefaults & MemoryCallOptions as its third argument. The signal reaches the matching MemoryStore/MemorySearchProvider method's second argument. Adapters should forward it using their database SDK's supported cancellation mechanism; interruption is not guaranteed by every SDK.

```ts
const result = await memory.search({ query: "database", limit: 5 }, { signal: AbortSignal.timeout(5000) });
if (result.status === "cancelled") console.log(result.error?.code); // MEMORY_CANCELLED
```

The direct SDK returns a cancelled NodeResult when it detects cancellation. Runtime invocation also enforces its own rejection semantics. Cancellation cannot roll back completed database writes and never triggers retries. Runtime Workers supply their signal and invocation-bound runtime; the MEMORY → RETRIEVAL bridge preserves both. Applications normally omit runtime. Database/embedding providers can still execute directly through their SDKs, delegating to RETRIEVAL only when separate execution is needed.

For `RemoteRetrievalSearchProvider`, omit construction-time runtime inside a MEMORY Worker to inherit its invocation-bound Runtime. An explicit runtime always takes precedence; standalone SDK delegation requires it. Example: `new RemoteRetrievalSearchProvider({ target: { name: "memories" } })` for Worker-owned delegation.

[Complete memory workflows](memory-workflows.md) demonstrate relational and vector storage, explicit embedding, scoped recall and durable recovery.
