# Composing a RAG application with public APIs

[简体中文](rag-workflows.zh-CN.md) · [API index](README.md) · [Full example](../../examples/patterns/rag-qa/README.md)

`runRag` is an application function, not an additional `@codesoul-co/ditto` export. Core exposes Runtime, Graph, Workers and retrieval provider interfaces. Source formats, authorization rules, checkpoints, prompts, citation validation and delivery belong to the application.

## Runnable consumer

Use Node.js 24+. Install `@codesoul-co/ditto` (or its `npm pack` tarball before publication). Copy `examples/patterns/rag-qa`, `examples/_shared/tools/rag`, `examples/_shared/tools/storage` and `examples/_shared/tools/execution/files.ts`, `examples/_shared/tools/evidence.ts` into the same relative paths in the consumer. Install storage dependencies, configure `ditto.yaml` and model credentials, and set `DITTO_WORKER_CONTEXT_REDIS_URL`. Save this at the application root as `rag-client.ts`:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { runRag } from "./examples/patterns/rag-qa/index.ts";
import { openRag } from "./examples/patterns/rag-qa/cli.ts";
import { createFixture, seedInternalKnowledge } from "./examples/patterns/rag-qa/fixtures.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_RAG_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-rag-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-rag-tasks/consumer-"));
const request = await createFixture(directory);
const app = await openRag(directory, request, config);
try {
  await seedInternalKnowledge(app.runtime); // trusted controller ingestion
  const result = await runRag(app.runtime, {
    request,
    model: { provider, model },
  }, { signal: AbortSignal.timeout(180_000) });
  if ("status" in result) throw new Error("Unexpected checkpoint");
  console.log(JSON.stringify({ directory, answer: result.answer }, null, 2));
} finally {
  await app.close();
}
```

```sh
node --env-file=.env rag-client.ts
```

`createFixture` constructs demonstration material. Replace it with trusted catalog configuration and an authenticated request for your application. Internal knowledge ingestion, including `seedInternalKnowledge`, is a trusted controller operation.

## Registration and execution

| Public entry | Nodes | Purpose |
| --- | --- | --- |
| `createDitto`, `graph`, `loop`, `graphStep` from `@codesoul-co/ditto/runtime` | Runtime / graph dependencies | `runRag()` calls one `runtime.loop(runRagLoop, ...)`; the plan yields every stage Graph |
| `createContextWorker` | `CONTEXT.LOAD`, `CONTEXT.UPDATE` | Redis working-set loading and assembly |
| `createMemoryWorker` | `MEMORY.GET`, `MEMORY.WRITE` | Approved internal knowledge and durable checkpoints |
| `createRetrievalWorker` | `RETRIEVAL.SEARCH` | Authorized, versioned text index |
| `createInferWorker` | `INFER.REASONING.SAMPLE` | Understanding, screening, generation, grounding |
| `createInteractionWorker` | `INTERACTION.ACT.TOOL` | Authorization, ingestion, snapshot checks, delivery |

Worker factories come from the respective `@codesoul-co/ditto/worker/context`, `memory`, `retrieval`, `infer`, and `interaction` exports. Application code never calls Worker executors or imports private source/build paths.

The application injects a `RetrievalTargetRegistry` with `createTextSearchProvider`: target `rag-corpus`, strategy `bm25`, namespace `<tenant>:<principal>:<requestId>`. Database queries are implementation details of the application provider. The graph invokes public `RETRIEVAL.SEARCH`.

Internal knowledge is first loaded through `MEMORY.GET` using approved keys, then indexed as text for the same query construction and ranking pipeline as user documents. External knowledge comes from a separate business database. Task checkpoints are not knowledge documents.

## Request and result

```ts
interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  sourceIds: string[];
}
interface Options {
  signal?: AbortSignal;
  stopAfter?: "indexed" | "retrieved" | "selected" | "report";
}
```

The host supplies authenticated identity and a trusted source catalog. `openRag` and `runRag` bind the same normalized request. Changed questions require new IDs.

A complete `Report` contains `plan` (intent, queries, facets, clarification), `selection` (chunk IDs, missing facts, conflicts), `evidence` (source kind, URI, title, snapshot hash, line range, text), `answer` (status, cited claims, limitations), `trace` (stage summaries, not hidden reasoning), and `grounding` (`model-checked` or `no-claims`, not human approval).

Checkpoints return `{status:"checkpoint", stage}`. Storage/source faults, budget overflow, malformed output, invalid citations and failed grounding throw errors rather than returning successful business statuses. Use Runtime observability for diagnostics without exposing connection details to users.

## Approved internal knowledge ingestion

A trusted controller can write curated knowledge through the public Memory node:

```ts
import { graph } from "@codesoul-co/ditto/runtime";
const ingest = graph("approved-knowledge").node("saved", "MEMORY.WRITE", [], () => ({
  memories: [{
    key: "knowledge:demo:maintenance",
    content: {
      kind: "knowledge", tenant: "demo", title: "内部知识库维护规范",
      text: "内部知识库每周三由资料管理员检查。"
    }
  }]
}));
const output = await runtime.run(ingest, {});
if (output.saved.status !== "success") throw new Error("Knowledge write failed");
```

Different content at the same key is not an idempotent write. Use public `MEMORY.UPDATE` for revisions and start a new RAG task to ingest them. Resumed tasks retain their initial source snapshots.

## Ownership and extension points

- `index.ts`: full state machine, public graphs, prompts and checkpoint recovery.
- `cli.ts`: explicit configuration, connection lifecycle and cancellation.
- `fixtures.ts`: demonstration source setup and approved knowledge ingestion.
- `tools/rag/domain.ts`: request, chunk, budget, citation and result contracts.
- `tools/rag/adapters.ts`: files, business SQLite, FTS, snapshots and delivery tools.

Replace providers/ingestion tools to connect enterprise or vector stores while preserving authority, locators and versions. Existing public embedding, hybrid and rerank interfaces remain available. This example executes SQLite FTS5; it does not claim end-to-end validation of alternative backends.

The host owns authentication, distributed task locking, credentials, log redaction and retention/access policies. Use one executor per task directory. Models receive neither database credentials nor executable operation authority.

## Package consumer verification

`npm run check:examples:rag:package -- --provider deepseek` installs a real tarball outside the repository, performs strict typing without path aliases, and guards resolved module paths against private entrypoints. Tasks use a real model, Redis, Memory SQLite, business SQLite, FTS and output files. Importing modules performs no task or network/file side effect.

[Graph composition through Loop](graph-loops.md)
