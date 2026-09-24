# Information retrieval and search through public APIs

[简体中文](search-workflows.zh-CN.md) · [API index](README.md) · [Eight examples](../../examples/capabilities/retrieval/README.md)

These workflows compose existing public Workers, Providers and Graphs. Vocabulary rules, HTML decoding, database indexes, source snapshots and report validation remain application code. No business-specific Core node is necessary.

| Public API | Purpose |
| --- | --- |
| `createDitto`, `graph`, `runtime.run` from `@codesoul-co/ditto/runtime` | Register Workers and execute planning, retrieval, storage and publication graphs |
| `createRetrievalWorker`, `RetrievalTargetRegistry` from `@codesoul-co/ditto-retrieval` | Bind permitted document and knowledge targets |
| `createTextSearchProvider`, `createSqlSearchProvider` / `RETRIEVAL.SEARCH` | Keyword and parameterized FTS lookup |
| `createWebSearchTool`, `WebSearchProvider`, `createBraveWebSearchProvider` from `@codesoul-co/ditto/worker/interaction` | Search-engine contract and exported Brave implementation |
| `createInteractionWorker`, `RegisteredTool` / `INTERACTION.ACT.TOOL` | Run search, page-reading and local publication tools |
| `createInferWorker` / `INFER.REASONING.SAMPLE` | Select queries and exact quotations |
| `createContextWorker({ redis })` / `CONTEXT.LOAD/UPDATE` | Real Redis session Context |
| `createMemoryWorker({ store })` / `MEMORY.GET/WRITE/SEARCH` | Internal knowledge, database Memory and recovery checkpoints |

## Complete invocation

Place this code at the application root. Install `@codesoul-co/ditto`, copy `examples/capabilities/retrieval/`, `examples/_shared/tools/retrieval/`, `examples/_shared/tools/storage/`, and `ditto.yaml` into the consumer, then install application SDKs:

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
```

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { RetrievalAdapters } from "./examples/_shared/tools/retrieval/adapters.ts";
import { importInternalKnowledge } from "./examples/_shared/tools/retrieval/memory.ts";
import { createFixture } from "./examples/capabilities/retrieval/fixtures.ts";
import { sandbox } from "./examples/capabilities/retrieval/cli.ts";
import { run } from "./examples/capabilities/retrieval/multi-source.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-retrieval-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-retrieval-tasks/app-"));
// Replace the fixture with a trusted application request, documents and knowledge database.
const { request, internalKnowledge } = await createFixture(directory, "multi-source", { knowledge: "both" });
const adapters = new RetrievalAdapters(directory, request);
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: sandbox(config, request, adapters),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createRetrievalWorker({ providers: adapters.providers, defaults: config.retrieval }),
        createInteractionWorker({ tools: adapters.tools }),
      ],
    });
    try {
      await importInternalKnowledge(runtime, request.tenant, internalKnowledge);
      const report = await run(runtime, { request, model: { provider, model } });
      console.log(directory, report);
    } finally { await runtime.close(); }
  } finally { await storage.close(); }
} finally { adapters.close(); }
```

Run with `node --env-file=.env app.ts`. The sandbox helper preserves configured model origins, adds trusted page/search origins, and limits tool names. Model responses cannot add sources or permissions.

## Internal versus external knowledge

`Request.knowledge` selects `internal | external | both`. Internal knowledge is managed by Agent Memory; external knowledge remains owned by an independent database or system. This is unrelated to public versus private networks. The external SQLite FTS5 adapter can be replaced with an enterprise database or service Provider without importing the entire external source into Memory.

[importInternalKnowledge](../../examples/_shared/tools/retrieval/memory.ts) explicitly ingests approved `{ kind: "knowledge", tenant, title, text }` records under `knowledge:<tenant>:<name>`. Internal graph nodes call `MEMORY.SEARCH` with `{ query: "retention", strategy: "keyword", filter: { key: "knowledge:team-a:retention" }, limit: 1 }`. Check `NodeResult.status` and then inspect `output`, a list of `MemorySearchResult` containing complete Memory records.

The application supplies the permitted `internalKnowledgeKeys`, searches each exact key, validates record kind/tenant, and archives source snapshots. This uses database search, not pretrained model knowledge. Redis Context remains task context rather than a knowledge database.

External retrieval uses target `knowledge-external`. Reports label the two paths `knowledge-internal` and `knowledge-external`, locating internal excerpts by Memory ID/key/content.text and external excerpts by table/row/column. Combined retrieval preserves each source without an implicit trust ranking. Archiving an external result for task recovery does not promote it into approved long-term knowledge.

## External search and tool contracts

A `RETRIEVAL.SEARCH` graph node accepts `{ target: { name: "knowledge-external", namespace: "team-a" }, query: { content: "retention" }, strategy: "fts5", limit: 3 }`. Run it through `runtime.run`. Check the returned `NodeResult.status` and `output` before using `output.candidates`. Each candidate contains body `content`, a `source.ref` URI and application-defined `metadata.evidence` with locations and snapshots.

The SQL Provider owns dialect, bound parameters, tenant authorization, sorting and limits. Core does not replace business authorization. See [retrieval providers](retrieval-providers.md) for the Provider contracts.

Call `INTERACTION.ACT.TOOL` with `{ call: { id, name: "retrieval_read_page", arguments: { url, query } } }`; check `ExternalResult.status` before reading `structuredContent.evidence`. `web_search` accepts `{ query, limit }` and returns `structuredContent.results`. Search snippets are discovery leads; reports cite fetched body text.

## Request and recovery protocol

The [Request contract](../../examples/_shared/tools/retrieval/domain.ts) requires `id`, `tenant`, `mode`, `knowledge`, `internalKnowledgeKeys`, `question`, `query`, `vocabulary`, `documents`, `urls`, `allowedOrigins`, `searchEngine`, and `allowPartial`. A trusted controller supplies and validates input through `request(value)`. Document names are Markdown filenames inside the task directory. Rewriting chooses one exact vocabulary entry; expansion chooses 2–3 distinct entries; other modes retain the fixed query. The application validates query counts and lengths.

`run(runtime, input, { signal?, stopAfter? })` accepts cancellation. `stopAfter: "queries" | "evidence"` returns `{ status: "checkpoint", stage }`. A full run returns a `Report` with `requestId`, `question`, `queries`, `evidence`, `findings`, `failures`, and `status`. Evidence contains `id/source/uri/title/text/location/snapshot/queries`; each finding is `{ sourceId, quote }`.

The sequence is request archive → Redis Context → model query plan → query archive → actual retrieval → evidence archive → model excerpts and validation → report archive → local publication. Memory keys are `retrieval:<id>:request|queries|evidence|report`; Context scope is `{ sessionId: "retrieval:<id>" }`. Cache misses rebuild exclusively through `MEMORY.*`; other Context failures do not trigger fallback.

Memory commits define recovery boundaries. A process killed after a commit but before a Context update restores from the database. A committed report with failed file output retries idempotent publication only. Uncommitted inference or reads may repeat. A digest binds the request ID to its content; edits require a new ID. The caller supplies serial task ownership and directory access control.

Reports contain validated source excerpts. `allowPartial` governs failed sources; empty matches produce `no-evidence`. `completed` means workflow completion, not independent factual verification. See the [examples guide](../../examples/capabilities/retrieval/README.md) for source restrictions and full package E2E commands.
