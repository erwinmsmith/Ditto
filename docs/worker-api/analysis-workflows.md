# Information organization and analysis through public APIs

[简体中文](analysis-workflows.zh-CN.md) · [API index](README.md) · [Seven examples](../../examples/capabilities/analysis/README.md)

The workflow uses public Worker interfaces to turn actual materials into traceable facts and comparisons. A model extracts values and quotations; the application owns schemas, reference authority, normalization, verification, arithmetic and output.

| API / node | Responsibility |
| --- | --- |
| `createDitto`, `graph`, `runtime.run` | Register Workers and execute ingestion, inference, persistence and delivery graphs |
| `createInteractionWorker({ tools })` / `INTERACTION.ACT.TOOL` | File decoders, HTTP reading, snapshots, application analysis and report files |
| `createInferWorker()` / `INFER.REASONING.SAMPLE` | Extract fields, values, units and quotations from Redis Context |
| `createContextWorker({ redis })` / `CONTEXT.LOAD/UPDATE` | Real Redis Context and restoration |
| `createMemoryWorker({ store })` / `MEMORY.GET/WRITE/SEARCH` | Database checkpoints and separately named internal knowledge |
| `createRetrievalWorker`, `createSqlSearchProvider` / `RETRIEVAL.SEARCH` | Query approved external document IDs with tenant binding |

Business adapters live in [tools/analysis](../../examples/_shared/tools/analysis/README.md). No business-specific Core node or private source import is required.

## Complete invocation

Save the code below at the application root and configure the model, Redis and parser environment. An installed-package consumer copies `examples/capabilities/analysis/` and the `analysis`, `file-ingestion`, `retrieval`, `storage` directories from `examples/_shared/tools/`, plus `ditto.yaml`. Install application dependencies following the [examples guide](../../examples/capabilities/analysis/README.md).

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { importInternalKnowledge } from "./examples/_shared/tools/retrieval/memory.ts";
import { AnalysisAdapters } from "./examples/_shared/tools/analysis/adapters.ts";
import { createFixture, pythonPath } from "./examples/capabilities/analysis/fixtures.ts";
import { sandbox } from "./examples/capabilities/analysis/cli.ts";
import { run } from "./examples/capabilities/analysis/compare.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-analysis-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-analysis-tasks/app-"));
// Replace the fixture with the application request, files, pages and knowledge sources.
const fixture = await createFixture(directory, "compare");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new AnalysisAdapters(directory, fixture.request, pythonPath());
    try {
      const runtime = createDitto({
        config,
        sandbox: sandbox(config, fixture.request, adapters),
        workers: [
          ...storage.workers, createInferWorker(),
          createRetrievalWorker({ providers: adapters.providers }),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      try {
        await importInternalKnowledge(runtime, fixture.request.tenant, fixture.knowledge);
        const report = await run(runtime, {
          request: fixture.request, model: { provider, model },
        });
        console.log(directory, report);
      } finally { await runtime.close(); }
    } finally { adapters.close(); }
  } finally { await storage.close(); }
} finally { await fixture.server.close(); }
```

Run `node --env-file=.env app.ts`. The [orchestration source](../../examples/capabilities/analysis/shared.ts) preserves model network permissions and explicitly admits trusted page origins.

## Input contracts

Validate `Request` using the application `request(value)` function. It contains `id`, `tenant`, `mode`, `question`, `period`, `subjects`, `sources`, and `allowedOrigins`. Each source has `id`, `format`, `origin`, `authority`, `period`, and `locator`.

Formats are text, web, csv, xlsx, pdf, image, memory, and external. Origins are document, web, knowledge-internal and knowledge-external and must match the transport. Authority is reference or claim, supplied by a trusted controller. Locators are local filenames, approved URLs, current-tenant `knowledge:<tenant>:<name>` Memory keys, or admitted external database document IDs. Model output cannot grant authority, choose new sources, change tenants or merge periods.

The example schema covers retention days, storage GB and support hours. To handle another business schema, update application field/unit contracts, extraction instructions and validation rules; public Core interfaces remain the same.

## Execution and output

The runtime archives the request in Memory and loads Redis Context. File and page graphs call actual decoders through tools. Internal knowledge uses exact-key `MEMORY.SEARCH` and kind/tenant validation; external knowledge uses the bound `RETRIEVAL.SEARCH` Provider. Parsed sources, positions and snapshots are archived before inference. The model returns claims and unresolved blocks; an application tool validates quotations, converts units, groups duplicates, finds conflicts, checks references and computes differences. The report is committed to Memory before JSON/CSV/Markdown publication.

Check `NodeResult.status/output` for Memory, Retrieval and inference, and `ExternalResult.status` before tool `structuredContent`. Failures never become empty success results.

The model emits `{ claims, unresolved }`. Claims contain blockId, subject, field, original numeric value/unit, and exact quote. Every input block must appear exactly once as a claim or unresolved entry. Models do not assign authority or resolve contradictions.

`Report` includes material, normalized claims, unresolved blocks, groups, duplicates, conflicts, comparison and differences. A claim's blockId resolves to sourceId, location and snapshot; sourceId resolves to URI and parser. SHA-256 snapshots preserve original bytes or database/Memory JSON records.

Deduplication keys include object, field, period and normalized value. Conflict keys exclude the value. Verification is unverified without references, supported when matching consistent references, refuted when disagreeing, and disputed when references disagree. Repetition does not establish authority. This checks consistency with designated references rather than universal truth or publisher authenticity. Comparisons use supported values for the requested period and calculate right minus left; missing or disputed values and differences remain null.

## Recovery and validation

`run(runtime, input, { signal?, stopAfter?: "sources" })` supports cancellation and a source checkpoint. Memory keys are `analysis:<id>:request|sources|report`; Redis scope is `{ sessionId: "analysis:<id>" }`. Only cache misses rebuild from database Memory; unavailable services fail explicitly. Committed sources are not fetched again, and source ownership remains distinct.

Uncommitted reads/inference may repeat. A committed report only retries idempotent output. Canonical request hashing survives JSON property reordering; changed sources, periods or trust rules require a new request ID. The application serializes controllers per task.

`npm run check:examples:analysis:tasks:package` installs the tarball outside the repository, checks strict public types/module boundaries and runs real tasks. Tests use actual models, Redis, database Memory, file parsers, OCR, HTTP and SIGKILL child recovery. The controlled HTTP fixture and SQLite coverage do not imply that every production knowledge platform or database has been tested.
