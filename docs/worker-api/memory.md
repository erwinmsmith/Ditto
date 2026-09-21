# MEMORY Worker API

[简体中文](memory.zh-CN.md) · [Worker API](README.md)

MEMORY implements GET, QUERY, SEARCH, WRITE, UPDATE and DELETE as stable access primitives over externally supplied storage/search plugins. Ditto handles routing, validation, result envelopes and injection. Applications own database clients, connections, schema, indexes and migrations. Core includes no SQL statements, MySQL/PostgreSQL drivers, Milvus client or database deployment.

## Setup

```ts
import { createDitto, createMemory, createMemoryWorker, loadRuntimeConfigFile } from "@ditto/core";
import type { MemoryResources } from "@ditto/core/worker/memory";

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

Supply resources from an application-owned adapter package. `MemoryOptions` contains `{ store, search, defaults?, concurrency? }`; defaults are `{ queryLimit?, searchLimit? }`. `createMemory` exposes `execute(node, input)` and `get/query/search/write/update/delete(input)`, all returning the same NodeResult as Runtime invocation. `createMemoryWorker` registers all six nodes for Graphs, `ctx.invoke` and existing HTTP transport. Concurrency limits apply only to Runtime Worker entry calls; the standalone SDK does not schedule calls.

## Replaceable plugin ports

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

| Deployment | store | search |
| --- | --- | --- |
| MySQL / PostgreSQL | External relational adapter | Its supported search implementation or a separate search plugin |
| Standalone Milvus | Milvus adapter implementing record CRUD and structured query | The same Milvus adapter |
| Mixed backends | Any MemoryStore | Any MemorySearchProvider |

One object may implement both ports: `createMemoryWorker({ store: backend, search: backend })`. Milvus does not require SQL. A separate search plugin must return complete MemoryItems and manage its own source/index mapping, consistency and permissions; Ditto performs no implicit SQL lookup.

No base class or registry is required. Plugins own dialects/expressions, parameterization, serialization, tenant/namespace isolation, transactions, conflict detection, timeouts and cleanup. Registering the same Worker definition shares the injected plugin objects; create separate plugins/definitions when isolation is needed. Runtime shutdown drains accepted operations but does not close application-owned connections.

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

NodeResult is shared with INFER through `@ditto/core/contracts`. Plugin methods return raw outputs; MEMORY wraps them once. This implementation emits success/failed, with no independent cancellation/deadline mechanism. Plugins enforce backend deadlines; failure does not imply rollback.

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

MEMORY does not call other Core Workers, schedule RAG/consolidation/eviction, or manage Skills. The Runtime helper `runRagFlow` in memory scope composes SEARCH → application mapping → CONTEXT.UPDATE. Failed searches stop before Context mutation. Since content is unknown, callers provide mapMemory:

```ts
import { runRagFlow } from "@ditto/core/runtime";
await runRagFlow(runtime, {
  scope: "memory", context: { items: [] }, query: "user preferences",
  mapMemory: ({ memory, score }) => ({
    id: `memory:${memory.id}`, sourceNode: "MEMORY.SEARCH",
    content: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    metadata: { memoryId: memory.id, ...(score === undefined ? {} : { score }) },
  }),
});
```

This mapping example assumes JSON content; applications must satisfy Context's JSON contract. Applications resolve Skills before `runSkillFlow({ context, skill })` activates CONTEXT.SKILL. SkillRegistry now lives in the context directory; its root export remains available.

## Migration and verification

Replace MEMORY.RETRIEVE with GET/QUERY, MEMORY.RAG.* with SEARCH, and CONSOLIDATE/EVICT with application Graph/policy compositions. MEMORY.SKILL is removed. MemoryItem.message becomes content; Runtime outputs now use shared NodeResult. Obsolete scaffold modules and aliases are removed.

`npm run check` covers injected-plugin CRUD, standalone/mixed resources, passthrough, validation, configuration, failure isolation and actual local HTTP transport. These fixture plugins verify Ditto contracts, not real MySQL/PostgreSQL/Milvus integration. External adapter repositories should verify persistence, query semantics, transactions and index consistency against their databases.

## Optional independent retrieval service

Ordinary MemorySearchProviders remain unchanged. When independent retrieval resources are needed, explicitly import RemoteRetrievalSearchProvider from `@ditto/core/worker/retrieval/adapters/memory`, supplying a fixed target and, where needed, batch mapOutput. It delegates MEMORY.SEARCH to RETRIEVAL.SEARCH without changing the caller contract. MEMORY neither imports nor starts the extension. See [integration and deployment](retrieval.md).

The same storage plugin/connection can also supply native search. Optional helpers support both directions: createMemoryRetrievalProvider wraps that native search for RETRIEVAL; createRetrievalMemorySearchProvider runs an embedding/search/fusion/rerank pipeline directly inside MEMORY without starting another Worker. Remote mapping is optional when candidates contain complete MemoryItems. See [database and embedding wiring](retrieval-providers.md). Embedding during SEARCH does not make WRITE automatically index or synchronize vectors.
