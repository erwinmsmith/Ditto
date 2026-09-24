# Long-term memory and task state APIs

[中文](memory-workflows.zh-CN.md) · [Memory node contracts](memory.md) · [Complete examples](../../examples/capabilities/memory/README.md)

Four capabilities share public MemoryStore/MemorySearchProvider contracts and Runtime Graphs. Switching relational or vector databases replaces application adapters, without private imports or database-specific Core nodes.

## Complete invocation

Save this TypeScript example at the repository root and run `node --env-file=.env your-example.ts` with Node.js 24, a real model, Redis and the selected database. Package consumers copy the memory examples plus shared memory/storage tools, install Redis/pg application dependencies and configure the model. These helpers are application code, not Core package exports.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openMemoryStorage } from "./examples/_shared/tools/memory/storage.ts";
import { memoryTools } from "./examples/_shared/tools/memory/adapters.ts";
import { namespace, type Backend } from "./examples/_shared/tools/memory/domain.ts";
import { createFixture } from "./examples/capabilities/memory/fixtures.ts";
import { sandbox } from "./examples/capabilities/memory/cli.ts";
import { writeMemories } from "./examples/capabilities/memory/shared.ts";
import { run } from "./examples/capabilities/memory/update.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
const backend: Backend = "sqlite"; // "postgres" or "qdrant" uses the same workflow.
await mkdir(".examples-memory-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-memory-tasks/api-"));
const fixture = await createFixture(directory, "update", backend);
const storage = await openMemoryStorage({
  directory, backend, namespace: namespace(fixture.request), config,
});
try {
  const runtime = createDitto({
    config, sandbox: sandbox(config),
    workers: [...storage.workers, createInferWorker(),
      createInteractionWorker({ tools: memoryTools(directory, namespace(fixture.request)) })],
  });
  try {
    await writeMemories(runtime, fixture.memories);
    console.log(await run(runtime, { request: fixture.request, model: { provider, model } }));
  } finally { await runtime.close(); }
} finally { await storage.close(); }
```

Fixtures provide repeatable inputs. Business callers supply authenticated namespaces, explicitly approved preferences and actual project files, reusing the user's database for later tasks. `run` accepts `{signal,stopAfter:"progress"}` and returns a report or `{status:"checkpoint"}`.

## Core wiring and operations

Register `createMemoryWorker({store:databaseStore,search:optionalSearchProvider,concurrency:1})` from `@ditto/core/worker/memory`. A store may implement its own native search; a separate search provider overrides it.

| Capability | Node input | Behavior |
| --- | --- | --- |
| Recall | `MEMORY.SEARCH({query,strategy,filter,limit})` | `{memory,score?}[]`; SQL uses keyword, Qdrant uses vector |
| Read/restore | `MEMORY.GET({ids?,keys?})` | Existing records only |
| Pagination | `MEMORY.QUERY({filter,limit,cursor?,orderBy?})` | `{items,nextCursor?}`; example adapters support ascending IDs |
| Policy-based write | `MEMORY.WRITE({memories:[{key,content,metadata}]})` | Application validates permission/evidence; adapter handles idempotency and conflicts |
| Revise/augment | `MEMORY.UPDATE({memories:[{id,content?,metadata?}]})` | Missing targets fail; omitted fields stay; provided metadata replaces the object |
| Delete | `MEMORY.DELETE({ids})` | IDs actually removed; scope adapter prevents cross-user operations |
| Checkpoint | `MEMORY.WRITE` with a separate task key | Canonical request fingerprint, stage and intermediate results |

Memory returns NodeResult. Check `status === "success"` before `.output`; backend errors are not an empty recall. Context returns raw Context and throws ContextError. These SQL/Qdrant adapters admit string filter fields `key/namespace/kind`. Filtering is a backend contract, not a universal Core query language. `scopedMemory` adds the trusted namespace, rejects forged keys/filters/metadata and checks ownership before ID mutations.

## Relational and vector adapters

`openSqliteMemory(path)` uses file SQLite and transactions. `openPostgresMemory(url,table)` uses parameterized PostgreSQL queries, transactions and unique keys. The generic SQL adapter retains its MySQL dialect, but this task suite validates SQLite/PostgreSQL.

`openQdrantMemory({url,collection,dimensions,embedding,embeddingIdentity,apiKey?})` stores complete records and supplies vector search. Preference `content.text` goes through public `embedContents` with an injected EmbeddingProvider; queries use the same model, then Qdrant performs native Cosine retrieval. UPDATE upserts new payload and regenerated vectors together. GET by key/ID needs no embedding. Checkpoints store payload with `vector:{}`, never fabricated semantic vectors.

Keys map to stable UUIDs. Writes reconcile full existing records; different values require UPDATE. Stable IDs do not replace a multi-writer transaction. A collection schema manifest fixes model identity, dimensions, preprocessing and distance; mismatches refuse startup. Reindex into a new collection when changing models.

Writes use Qdrant's documented [`wait=true` completion confirmation](https://qdrant.tech/documentation/manage-data/points/); pagination uses [scroll and offset](https://api.qdrant.tech/api-reference/points/scroll-points). Backend HTTP routes and SDKs remain outside Core. Configure model, dimensions, endpoint and credentials together; vector storage alone does not embed text.

## Durable protocol

1. Read the real project file and relevant long-term memory; commit base.
2. For mutations, infer a proposal, validate permission/evidence and commit candidate. Read current memory: matching operation ID/content means the mutation already took effect; otherwise WRITE/UPDATE only if the baseline still matches.
3. Commit progress with intermediate results, memory snapshot and request fingerprint. Restore it after a pause or Redis expiry.
4. Infer from restored Redis context, validate consistency with memory/progress, commit report, then publish the file.

There is no cross-service transaction between a mutation and its checkpoint. Uncommitted model steps may repeat after a crash; actual-record reconciliation avoids repeating a completed mutation. Committed reports do not repeat inference. An ongoing task uses its committed memory snapshot for reproducibility; new tasks recall current long-term memory. Hosts enforce authenticated identities and one active writing controller per user/task.
