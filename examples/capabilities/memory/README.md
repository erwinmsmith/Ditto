# 3.6 Memory capabilities

[中文](README.zh-CN.md) · [Capabilities](../README.md) · [API invocation](../../../docs/worker-api/memory-workflows.md)

Four examples compose public `MEMORY.*`, `CONTEXT.*`, `INFER.*` and Runtime Graphs to produce project progress messages. Redis holds working context. The selected relational or vector database holds long-term memory and durable task checkpoints.

| Entry | Workflow | Verifiable result |
| --- | --- | --- |
| [search.ts](search.ts) | Recall communication preferences with `MEMORY.SEARCH`, load Redis context, infer | Apply the remembered language/style and cite the memory ID/version |
| [write.ts](write.ts) | Check permission, infer a proposal, validate exact evidence and policy, `MEMORY.WRITE` | A new task retrieves and uses the saved preference |
| [update.ts](update.ts) | Read existing preference, validate the revision, `MEMORY.UPDATE` the same ID | Apply revised preferences; regenerate the vector alongside content |
| [task-state.ts](task-state.ts) | Infer progress, persist it, restore with `MEMORY.GET` | Continue from committed progress without repeating completed stages |

Artifacts are `artifacts/<taskId>.json`, including the generated message, memory identity/version, language/style and task progress.

## Backends

| `--backend` | Persistent database | Search | Dependencies |
| --- | --- | --- | --- |
| `sqlite` | File SQLite | Parameterized SQL keyword search | Node.js 24 SQLite |
| `postgres` | PostgreSQL | Parameterized SQL keyword search | Application `pg` package and PostgreSQL |
| `qdrant` | Full Memory payloads and named vectors | Real embeddings and database-native Cosine search | Qdrant and an HTTP embedding service |

All three implement the public MemoryStore/MemorySearchProvider contracts. Qdrant embeds only `kind=preference` records; checkpoints use payloads without vectors. SQL keyword matching is not semantic search. Drivers, connection management and schema provisioning remain application code outside Core.

## Run

```bash
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
docker compose -f examples/_shared/tools/storage/compose.memory.yaml up -d
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:16579
export DITTO_WORKER_MEMORY_POSTGRES_URL=postgresql://postgres:ditto_example@127.0.0.1:15432/ditto
export DITTO_WORKER_MEMORY_QDRANT_URL=http://127.0.0.1:16333
export DITTO_WORKER_MEMORY_QDRANT_COLLECTION=agent_memories
export DITTO_WORKER_RETRIEVAL_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL=embedding-3
export DITTO_WORKER_MEMORY_EMBEDDING_DIMENSIONS=2048
# Put DITTO_WORKER_RETRIEVAL_EMBEDDING_API_KEY in your ignored .env file.
npm run example:memory:search -- --backend sqlite
npm run example:memory:write -- --backend sqlite
npm run example:memory:update -- --backend postgres
npm run example:memory:task-state -- --backend qdrant
```

Configure a real reasoning model in `ditto.yaml` / `.env`. Generation and embedding are separate models. The CLI creates randomized task files, an isolated user and demonstration memories. SQLite stores data in the task directory's `memory.sqlite`; reuse that database and trusted user identity for future conversations. PostgreSQL and Qdrant use the configured persistent table/collection. See [storage configuration](../../_shared/tools/storage/README.md).

```bash
npm run example:memory:task-state -- --backend postgres --checkpoint
# Substitute the directory printed by the first command.
npm run example:memory:task-state -- --directory .examples-memory-tasks/cli-XXXXXX
```

Resume reads the backend from `request.json`. Application callers import an entry's `run(runtime,{request,model},options)`, pass controller-owned tenant/user/permission, and register Workers using `openMemoryStorage({backend,directory,namespace,config})`. Imports do not connect or execute.

## Policy and recovery

Long-term keys use `<tenant>:<user>:memory:*`; checkpoints use `<tenant>:<user>:task:<taskId>:*`. Search requires `kind=preference`. Task checkpoints are not an enterprise knowledge base and never participate in semantic recall.

The write example admits only explicitly approved durable communication preferences. A model proposes values and exact quotes; it cannot grant storage permission. Expand the application policy deliberately for other domains. Scope enforcement covers all six Memory operations. The host authenticates identities; model content cannot choose a namespace.

The candidate is committed before the mutation. On retry, the application reads content and operation ID to determine whether the write/update already happened. It does not duplicate updates or increment versions again after an ambiguous response or crash. Progress and reports have separate checkpoints. Reports commit before atomic file publication, so publishing retries do not repeat inference.

Redis cache misses restore database state. Redis, database and embedding outages fail explicitly without switching storage. Use one active writing controller per user/task. SQL transactions and Qdrant `wait=true` are not cross-service transactions, and the Qdrant key check is not a multi-writer CAS. Multi-replica hosts need an external lock or conditional-write design.

A Qdrant collection fixes the embedding service/model, dimensions and preprocessing identity. Changing even an equal-dimensional model requires a new collection and reindexing.

## Acceptance

```bash
npm run check
npm run check:examples:memory:tasks
npm run check:examples:memory:tasks:package
npm run check:examples:memory:tasks -- --backend qdrant
```

The default suite requires all three real backends; missing configuration fails instead of skipping. It verifies real generation and embedding, artifacts, future-task memory use, pagination/isolation, vector updates, post-mutation SIGKILL, progress recovery, cache expiry, storage failures, denied storage permission, invalid proposals, embedding dimension/identity errors, cancellation and publication retries. The package gate installs the actual npm tarball outside the repository and checks strict types without paths aliases, public entries and silent imports before running tasks.

Generated files, databases, logs and `AGENTS.md` are ignored. Existing MySQL/Milvus single-node integrations remain in [database examples](../../../docs/worker-api/examples/integrations/README.md); this task suite does not imply validation against those backends.

Storage faults use temporarily unavailable real SQL tables and a Qdrant HTTP 503 proxy; recovery continues against the original database. Dimension corruption is injected after a real embedding response, never by substituting fixture vectors.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
