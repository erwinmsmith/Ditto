# Worker database examples

**English** · [简体中文](README.zh-CN.md) · [All examples](../README.md) · [Worker API](../../docs/worker-api/README.md)

These applications create SDK clients, inject Workers, perform real operations and close resources. Database drivers stay outside Ditto Core. Run commands from the **repository root**, using Node 24+.

| File | Purpose | Operations |
| --- | --- | --- |
| [context-redis.ts](context-redis.ts) | CONTEXT with a connected node-redis client | LOAD, UPDATE, SELECT, COMPRESS, restore; SELECT never writes back; delete this run's random scope on exit |
| [memory-sql.ts](memory-sql.ts) | MemoryStore and native keyword search for SQLite, PostgreSQL or MySQL | Create a random example table; run six MEMORY operations using bound SQL, JSON mapping, transactions and pagination; drop the table on exit |
| [memory-milvus.ts](memory-milvus.ts) | Milvus as both record storage and vector search | Create/load a random indexed collection; CRUD, query and cosine search; drop the collection on exit |
| [shared.ts](shared.ts) | SDK loading, NodeResult checking and shared MEMORY calls | runMemoryExample accepts MemoryResources and executes WRITE → GET → QUERY → SEARCH → UPDATE → DELETE |

Entry points run main only when executed directly. Importing adapters neither connects nor writes. SQL/Milvus examples require permission to create/drop tables or collections and clean up only their own random resources. Use a development database.

## Install and configure

```bash
npm ci
# Install only the optional SDKs you need. SQLite needs no additional driver.
npm install --prefix /tmp/ditto-worker-example-sdk --no-audit --no-fund --ignore-scripts \
  redis@6.2.1 pg@8.23.0 mysql2@3.24.4 @zilliz/milvus2-sdk-node@3.0.6
```

Copy relevant entries from root [`.env.example`](../../.env.example) into local `.env`. Commands use `--env-file-if-exists=.env`; existing shell variables take precedence.

```dotenv
DITTO_EXAMPLES_SDK_DIRECTORY=/tmp/ditto-worker-example-sdk
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
DITTO_WORKER_MEMORY_POSTGRES_URL=postgresql://user:password@127.0.0.1:5432/ditto
DITTO_WORKER_MEMORY_MYSQL_URL=mysql://user:password@127.0.0.1:3306/ditto
DITTO_WORKER_MEMORY_MILVUS_ADDRESS=127.0.0.1:19530
DITTO_WORKER_MEMORY_MILVUS_TOKEN=
```

SDK_DIRECTORY is read only by this example helper. Omit it to use application-local node_modules. Behavior stays in root [`ditto.yaml`](../../ditto.yaml): CONTEXT policy/TTL/keyPrefix and MEMORY queryLimit/searchLimit. Connection URLs and credentials stay in env.

## CONTEXT → Redis

With Redis running:

```bash
npm run example:worker:redis
```

The application uses one scope for all four operations, then reads back cached state. Its injection point is:

```ts
const worker = createContextWorker({
  ...(config.context.policy ? { policy: config.context.policy } : {}),
  redis: { client, ...config.context.cache },
});
await runtime.invoke("CONTEXT.LOAD", { scope, sources });
await runtime.invoke("CONTEXT.UPDATE", { scope, add });
const selected = await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer" });
```

To replace Redis, inject `services: { stateStore }`; scope and Graph calls stay the same. See [CONTEXT API](../../docs/worker-api/context.md).

## MEMORY → SQL

```bash
# In-memory SQLite, no server or connection settings needed.
npm run example:worker:sql -- sqlite
# Create the target database/account and set its URL first.
npm run example:worker:sql -- postgres
npm run example:worker:sql -- mysql
```

`openSqlDatabase(dialect)` uses Node DatabaseSync, pg.Pool or mysql2 Pool. `createSqlMemoryStore(database, table)` implements CRUD and native search together:

```ts
const store = createSqlMemoryStore(database, table);
const worker = createMemoryWorker({ store });
const runtime = createDitto({ workers: [worker] });
const result = await runtime.invoke("MEMORY.SEARCH", {
  query: "language", strategy: "keyword", limit: 5,
});
```

Columns are id, memory_key, content and metadata. Content/metadata are JSON text, including Unicode, objects and arrays. Identifiers are validated; query values are bound. Keys need not be unique; combined ids/keys use union semantics.

QUERY supports `filter: { key }` and `orderBy: [{ field: "id", direction: "asc" }]`, with id-based cursor pagination. Pass nextCursor to the next QUERY; this is not a cross-request snapshot under concurrent changes. SEARCH is case-insensitive literal substring matching inside the database, escaping `%`, `_` and `!`; it is not ranked full-text or vector search. Unsupported filters, ordering and strategies fail explicitly.

WRITE/UPDATE/DELETE use transactions. UPDATE checks all targets before changing them. PostgreSQL/MySQL lock targets on one transaction connection; SQLite serializes access to one connection. Metadata replaces the whole object. DELETE returns only existing deleted IDs; repeated deletion is empty.

For an application, use persistent tables/schema initialization and reuse a connection pool. Do not copy the demo's random-table create/drop lifecycle onto business tables. [MEMORY API](../../docs/worker-api/memory.md) · [pg queries](https://node-postgres.com/features/queries) · [MySQL2](https://sidorares.github.io/node-mysql2/docs).

## MEMORY → Milvus

Configure the endpoint and optional token, then run:

```bash
npm run example:worker:milvus
```

| Field | Purpose |
| --- | --- |
| id | VARCHAR UUID primary key |
| memory_key | Business key for GET/filter |
| payload | Complete MemoryItem JSON, preserving content, metadata and optional key |
| vector | FLOAT_VECTOR, 3 dimensions in this example; FLAT index with COSINE |

`createMilvusMemoryStore(client, collection)` calls native query/insert/upsert/delete/search with Strong consistency. Reads and hits restore complete MemoryItems without a companion SQL store.

```ts
const worker = createMemoryWorker({
  store: createMilvusMemoryStore(client, collection), concurrency: 1,
});
await runtime.invoke("MEMORY.WRITE", {
  memories: [{ key: "preference", content: { text: "Prefer Chinese", vector: [1, 0, 0] } }],
});
const hits = await runtime.invoke("MEMORY.SEARCH", {
  query: [1, 0, 0], strategy: "vector", limit: 5,
});
```

The handcrafted 3D vectors demonstrate database operations, not semantic embeddings. An application can generate embeddings through an external provider, optional RETRIEVAL, or native database capability. Keep document/query models, dimensions and metric consistent. This adapter receives precomputed vectors; text updates must supply the matching vector. It never implicitly calls a model.

QUERY supports key filtering and limit as a bounded query; this example rejects cursor/orderBy. GET rejects more than 10000 results instead of truncating. Payload is limited to 65535 bytes and business keys to 255 bytes.

This is a single-writer collection example. Worker concurrency=1 only covers its replica. Milvus read-modify-upsert and batch mutations have no SQL transaction guarantee; multiple writers need application coordination. Partial write or mismatched deletion counts fail explicitly and require reconciliation before retry, not an assumption of rollback. [Milvus Node SDK](https://github.com/milvus-io/milvus-sdk-node) · [Vector search](https://milvus.io/api-reference/node/v2.6.x/Vector/search.md).
