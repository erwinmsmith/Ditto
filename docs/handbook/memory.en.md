# Databases, persistent memory and custom search algorithms

Context and Memory have different lifetimes. Context is the current working set; complete Agent examples store it in Redis. Memory stores long-term records through an application-supplied persistent database. Optional RETRIEVAL can perform search computation but does not persist Memory for you.

## 1. Separate three kinds of state

| State | Examples | Storage |
| --- | --- | --- |
| Working context | Current question, observations, selected evidence | Redis Context with an optional TTL |
| Long-term Memory | Preferences, reviewed knowledge, conversations, checkpoints | SQL/document/vector database Memory adapters |
| Business facts | Orders, payments, publication records, idempotency ledger | The business database and its committed state |

Writing “order cancelled” into Memory does not cancel an order. Recovery must inspect business state rather than trusting generated summaries.

## 2. Configure Redis Context

```sh
npm install redis@6.2.1
```

```ts
import { createClient } from "redis";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
const redis = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL });
redis.on("error", error => { console.error("Redis connection failed", error.name); });
await redis.connect();
const contextWorker = createContextWorker({
  redis: { client: redis, ttlMs: 300_000, keyPrefix: "myapp:context:" },
});
// Register contextWorker; close runtime before redis.quit() during shutdown.
```

Register the Worker, then close the Runtime before calling redis.quit(). LOAD with sources initializes/replaces a scope; LOAD without sources reads it. All scope fields form the key; there is no automatic session-to-turn fallback. UPDATE/COMPRESS commit by version comparison. Conflicts are not automatically retried, and SELECT does not extend TTL.

Rebuild expired Context from Memory or checkpoints. Connection errors are infrastructure failures; silently switching to a process-local Map would break persistent recovery guarantees.

## 3. File SQLite as a persistent starting point

This adapter uses Node's built-in SQLite, without an additional SQLite npm driver:

```ts
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { openSqliteMemory } from "./examples/_shared/tools/storage/sqlite-memory.ts";

const database = openSqliteMemory("./memory.sqlite");
const runtime = createDitto({ workers: [createMemoryWorker({ store: database.store })] });
try {
  const written = await runtime.invoke("MEMORY.WRITE", {
    memories: [{ key: "alice:language", content: { language: "zh-CN" }, metadata: { namespace: "alice" } }],
  });
  if (written.status !== "success") throw new Error(written.error?.message ?? "Write failed");
} finally {
  try { await runtime.close(); } finally { await database.close(); }
}
```

`openSqliteMemory` is an application example adapter, not an npm export. It uses file storage, WAL, parameterized SQL, transactions and serialized connection operations. Read the complete [SQL implementation](../../examples/_shared/tools/storage/sql-memory.ts). An existing key with different content conflicts; use UPDATE with its existing id.

## 4. Separate Store and Search

| Interface | Required methods | Return type |
| --- | --- | --- |
| MemoryStore | get / query / write / update / delete | Raw Memory outputs, without NodeResult |
| MemorySearchProvider | search | `{memory,score?}[]` with complete records and stable IDs |

In `createMemoryWorker({store,search?})`, explicit search takes precedence; otherwise the Worker's search uses the store's search implementation. If neither exists, SEARCH fails instead of inventing vector search.

Store owns records. Search is a replaceable recall/ranking strategy. Graphs call MEMORY.SEARCH without depending on SQL LIKE, full-text indexes, vector databases or fusion internals.

## 5. Choose among six operations

- **GET:** exact read by id/key, useful for conversations and checkpoints.
- **QUERY:** enumerate with trusted filter/orderBy/cursor; adapters provide stable cursors.
- **SEARCH:** relevance retrieval; the adapter defines and validates query/strategy/options.
- **WRITE:** create Memory and return database-generated IDs. A business key is not automatically globally idempotent.
- **UPDATE:** partial update by id. When metadata is supplied, it replaces the entire metadata object; adapters must not silently deep-merge it.
- **DELETE:** delete existing IDs and return the identifiers actually deleted.

Runtime/Worker calls return NodeResult; database adapters return raw types. See the [MEMORY contracts](../worker-api/memory.md).

## 6. Custom algorithm: keyword candidates plus recency

The following connects to file SQLite, writes two records, recalls keyword candidates in the database and ranks them by time:

```sh
node examples/handbook/memory-ranking.ts
```

<<< ../../examples/handbook/memory-ranking.ts

Expect newer before older. Running again does not duplicate example records. The score `1/(1+ageDays)` is an application ranking formula, not probability or model confidence. A fixed evaluation time makes the example reproducible; define clock and timestamp rules for production.

This reranks at most 100 candidates and does not guarantee retrieval of all recent relevant records. For larger corpora, push ranking into the database/index or implement paginated recall. This small example is not a complete large-scale retrieval system.

## 7. The vector-memory pipeline

```text
Reviewed content
  → normalize and assign stable IDs
  → embed (record model, version, dimensions)
  → write authoritative records
  → update vector index / outbox
  → MEMORY.SEARCH(query)
      → query embedding
      → tenant filter and vector recall
      → hydrate records; remove deleted/expired entries
      → optional reranking
      → complete MemoryItem + score
```

A vector database is not an authorization system. Filter tenant, namespace, visibility and expiration during recall and verify them during hydration. If the database and index do not share a transaction, use an outbox/retry queue and versions. Propagate deletions too.

Do not compare embeddings from different models or dimensions. Rebuild or create a new index when changing embedding versions and keep query/index models aligned. Cosine similarity, distance, BM25 and fusion scores are not interchangeable confidence values.

## 8. PostgreSQL, MySQL, Qdrant and Milvus

[Storage adapters](../../examples/_shared/tools/storage/README.md) describe dependencies and connections. [Memory tasks](../../examples/capabilities/memory/README.md) include SQLite, PostgreSQL and Qdrant paths; [retrieval providers](../worker-api/retrieval-providers.md) cover SQL and Milvus contracts.

For a SQL driver, implement `rows` and `transaction`; transaction callbacks must use the same connection. PostgreSQL placeholders differ from MySQL/SQLite: convert in the adapter or implement natively. Model-produced SQL is not an unrestricted executable string.

Read connection URLs and passwords from application environment variables. `ditto.yaml` supplies behavior defaults; it does not install drivers, create tables, connect clients, migrate schemas or prepare indexes.

## 9. Writing policy is part of the algorithm

Choose what deserves long-term retention, then redact, deduplicate, verify sources and evaluate expiration. CONTEXT.SELECT with purpose=memory assists selection; it is not a complete privacy/authorization policy. Record sources, trusted principals, timestamps, versions and invalidation conditions.

Use UPDATE for existing facts and handle conflicts. Preserve conflicting sources and their status instead of overwriting verified facts with the latest generated answer. Separate task checkpoints from knowledge using kind/namespace.

## 10. Validate the integration

Test read-after-reopen, updates, deletes, pagination, empty results, invalid filters and tenant boundaries. Check dimension mismatch and indexing failures, cancellation, cleanup and recovery after Redis expiration. Do not return false success.

SQLite passing does not establish PostgreSQL, MySQL, Qdrant or Milvus compatibility in your environment. Install [optional retrieval](retrieval.en.md) only when you need its search resources.
