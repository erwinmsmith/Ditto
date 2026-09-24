# Context and Memory storage

[简体中文](README.zh-CN.md) · [Application tools](../README.md) · [Understanding examples](../../../capabilities/understanding/README.md)

Agent examples keep working Context in Redis and durable conversation memory behind database-backed `MEMORY.*` nodes. Business state and artifact ledgers remain separate. Core supplies public contracts and nodes; the application installs SDKs, opens clients, and closes resources.

## Installation and configuration

Use Node.js 24+:

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
```

Start an accessible Redis service and configure root `.env`:

```dotenv
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
```

Redis TTL and key prefix come from `workers.context.cache` in `ditto.yaml`. Connection timeout is five seconds; automatic reconnection is disabled and errors reach the caller. Keep credentials out of YAML and version control.

For local development, run `redis-server --bind 127.0.0.1 --port 6379` in a separate terminal. SQLite requires no server. `openSqliteMemory(filename)` requires a persistent path and rejects `:memory:`. Understanding examples create `memory.sqlite` in each session directory.

## Adapters

| File | Responsibility |
| --- | --- |
| [redis-context.ts](redis-context.ts) | Open a real Redis SDK client for `createContextWorker({ redis: { client, ...config.context.cache } })` |
| [sqlite-memory.ts](sqlite-memory.ts) | File database, WAL, serialized transactions, unique memory keys, and resource cleanup |
| [sql-memory.ts](sql-memory.ts) | Shared SQL MemoryStore: GET, QUERY, SEARCH, WRITE, UPDATE, DELETE |

```ts
const redis = await openRedisContext();
const memory = openSqliteMemory("./memory.sqlite");
const runtime = createDitto({
  config,
  workers: [
    createContextWorker({ redis: { client: redis, ...config.context.cache } }),
    createMemoryWorker({ store: memory.store, defaults: config.memory }),
  ],
});
// Call runtime.run(graph, input) or runtime.invoke("MEMORY.GET", input).
// Close runtime, memory, and redis when the application finishes.
```

The [SQL integration example](../../../../docs/worker-api/examples/integrations/memory-sql.ts) also reuses `sql-memory.ts`; its application adapters provide PostgreSQL/MySQL pools. File SQLite verification does not establish remote database verification.

The `memories` table stores `id`, `memory_key`, `content`, and `metadata`. Repeating a write with identical key and content returns the original record; conflicting content fails. Explicit `MEMORY.UPDATE` changes existing records. Query supports key filters, ascending IDs, and pagination. Search performs SQL substring matching, not vector ranking.

## Conversation recovery

Understanding examples isolate sessions with a UUID namespace and Context scopes containing namespace and revision. After each delivered interaction, `MEMORY.WRITE` archives turns, interpretation, and the artifact reference; the business ledger then acknowledges the archived revision. A key identifies one namespace/revision pair. A process stopped after the Memory commit can repeat the same write without creating duplicate records.

`MEMORY.GET` reads the last acknowledged archive; `CONTEXT.LOAD({ scope })` reads Redis. Only `CONTEXT_NOT_FOUND` permits rebuilding from Memory. Other storage failures surface to the caller. `CONTEXT.UPDATE({ scope, add })` merges current input. There is no fallback to a business-database Context snapshot.

The business database retains input journals for revision checks, evidence, and idempotency, plus the acknowledged Memory revision. It does not store a complete Context object. Redis expires via TTL; the application owns retention and deletion of Memory and business records. Namespaces are not authentication credentials.

## Verification

```sh
npm run check
npm run check:examples:understanding:tasks:package
```

Task tests inspect actual Redis values and TTL, inspect the independent Memory database, and cover cache expiry, storage failures before inference, Memory failure after report creation, and process termination after Memory commit. Package consumers install the Redis SDK independently and execute tasks through public Core entries.

[workers.ts](workers.ts) exports `openAgentStorage(directory, config)` to create Redis Context and file SQLite Memory Workers with explicit cleanup. Understanding and [planning examples](../../../capabilities/planning/README.md) share this initialization.

## Long-term memory backends

The [four memory workflows](../../../capabilities/memory/README.md) share MemoryStore/MemorySearchProvider contracts:

- `postgres-memory.ts`: `openPostgresMemory(url,table)` provisions a persistent table with unique keys, parameterized SQL and transactions; `pg` is an application dependency.
- `qdrant-memory.ts`: `openQdrantMemory(options)` stores complete payloads and named vectors, then performs native Cosine search. An injected real EmbeddingProvider encodes `content.text`. Its REST client bounds time and response size; no Qdrant SDK is needed.
- `scoped-memory.ts`: `scopedMemory(store,namespace)` constrains all six Memory operations to a host-authenticated user scope.
- `sql-memory.ts`: parameterized string filters `key/namespace/kind`, with dialect-specific JSON metadata extraction. Search remains keyword matching.

Install SDKs with `npm --prefix examples/_shared/tools/storage/dependencies install`. `compose.memory.yaml` binds Redis 16579, PostgreSQL 15432 and Qdrant 16333 to localhost and persists Docker volumes. Its credentials are for local examples; external deployments use host-managed authentication. `docker compose -f examples/_shared/tools/storage/compose.memory.yaml down` stops services while preserving data.

Configure `DITTO_WORKER_MEMORY_POSTGRES_URL/TABLE`, `DITTO_WORKER_MEMORY_QDRANT_URL/COLLECTION/API_KEY` and `DITTO_WORKER_MEMORY_EMBEDDING_DIMENSIONS`. Embedding reuses `DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL/MODEL/API_KEY`. Dimensions must match actual model output; changed model/preprocessing requires a new collection.

Hosts coordinate writers. SQL unique keys, Qdrant stable UUIDs/completion confirmation and application operation-ID reconciliation provide explicit retry behavior, not cross-database transactions or general concurrent CAS. Qdrant checkpoints have payloads without vectors; GET/QUERY need no embedding.
