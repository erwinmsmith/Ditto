# Information retrieval and search

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [Public APIs and invocation](../../../docs/worker-api/search-workflows.md)

Turn a question into executable queries, retrieve actual documents, knowledge records and web pages, and produce an evidence brief with verifiable excerpts. The model selects queries and quotations; the application validates vocabulary, source IDs, exact text and source coverage before writing JSON and Markdown reports.

| Capability | Entry | Behavior |
| --- | --- | --- |
| Document retrieval | [document-search.ts](document-search.ts) | Search specified Markdown files; retain URI, line numbers and original snapshots |
| Knowledge-base retrieval | [knowledge-base.ts](knowledge-base.ts) | Select internal Memory knowledge, an external knowledge source, or both with distinct provenance |
| Internet search | [web-search.ts](web-search.ts) | Search an engine and read an allowed result page; snippets are discovery leads only |
| Webpage reading | [web-read.ts](web-read.ts) | Fetch HTML, extract body text, save HTML and extracted-text snapshots |
| Multiple sources | [multi-source.ts](multi-source.ts) | Retrieve documents, knowledge records and web sources; optionally retain partial results |
| Query rewriting | [rewrite.ts](rewrite.ts) | Convert a colloquial question into a supported vocabulary query and execute it |
| Query expansion | [expand.ts](expand.ts) | Select and execute 2–3 distinct vocabulary queries; deduplicate with query provenance |
| Source location | [source-location.ts](source-location.ts) | Link excerpts to document lines, database rows or extracted webpage lines and SHA-256 snapshots |

Every entry exports `run(runtime, input, options?)`; imports perform no connections or task execution. [shared.ts](shared.ts) composes public Runtime graphs. Application transports, decoders and dependencies live in [tools/retrieval](../../_shared/tools/retrieval/README.md).

## Run

Use Node.js 24+, a configured model, and real Redis. Configure `.env` and `DITTO_WORKER_CONTEXT_REDIS_URL` using the [storage guide](../../_shared/tools/storage/README.md).

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
npm run example:retrieval:document-search
npm run example:retrieval:knowledge-base
npm run example:retrieval:web-search
npm run example:retrieval:web-read
npm run example:retrieval:multi-source
npm run example:retrieval:rewrite
npm run example:retrieval:expand
npm run example:retrieval:source-location
```

Each command creates a task directory and prints `{ directory, result }`. Fixture retention days and backup intervals vary per task, so results must use actual task data. The directory contains `request.json`, `policy.md`, `knowledge.sqlite`, database-backed `memory.sqlite` for explicitly ingested knowledge and separately named task checkpoints, `internal-knowledge.json` ingestion input, source files under `snapshots/<sha256>/`, and `artifacts/brief.json` / `artifacts/brief.md`.

Default internet search uses **Wikipedia full-text site search** without an API key; its coverage is limited to Wikipedia. For general web search, set a new request's `searchEngine` to `brave`, configure `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`, and supply trusted page `allowedOrigins`. Engines never silently fall back. Default direct webpage reading uses SQLite's official documentation. JavaScript execution and authenticated pages are outside this reader's scope.

## Internal and external knowledge

The distinction is relative to the Agent's knowledge-management boundary, not network location. An enterprise intranet database or knowledge platform can be an external source.

| Type | Ownership and API | Evidence source |
| --- | --- | --- |
| Internal knowledge | Explicitly accepted long-term facts, ingested with `MEMORY.WRITE` and retrieved with `MEMORY.SEARCH` | `knowledge-internal`, `memory:knowledge:<tenant>:<key>` URI |
| External knowledge | Material owned by another database or system, queried through `RETRIEVAL.SEARCH` and an application Provider | `knowledge-external`, external record location retained |
| Task memory | Request, query, evidence and report checkpoints restored through `MEMORY.GET/WRITE` | `retrieval:<requestId>:<stage>` keys, excluded from knowledge search |

The default selection is `external`; the independent SQLite FTS5 database demonstrates an external-source adapter. Internal mode uses database Memory and does not open `knowledge.sqlite`.

```sh
npm run example:retrieval:knowledge-base -- --knowledge internal
npm run example:retrieval:knowledge-base -- --knowledge external
npm run example:retrieval:knowledge-base -- --knowledge both
npm run example:retrieval:multi-source -- --knowledge both
```

The trusted controller supplies `request.knowledge` and permitted `internalKnowledgeKeys`. Internal lookup applies exact key filters, then validates record kind and tenant. It never searches other tenants or task checkpoints.

For a new internal/mixed CLI task, the controller ingests `internal-knowledge.json` using public `MEMORY.WRITE`; recovery does not reimport. Applications use [importInternalKnowledge](../../_shared/tools/retrieval/memory.ts) for explicitly approved facts, or supply existing permitted Memory keys. Model answers and external search results are never automatically promoted to internal knowledge. Both sources retain separate quotations and snapshots, without an implicit authority ranking; `allowPartial` also applies when one knowledge source fails.

## Resume

```sh
npm run example:retrieval:expand -- --stop-after evidence
npm run example:retrieval:expand -- --directory .examples-retrieval-tasks/cli-XXXXXX
```

Use the directory printed by the first command. `--stop-after` accepts `queries` or `evidence`. Requests, queries, evidence and reports are archived through `MEMORY.GET/WRITE`. Expired Redis Context is rebuilt from database Memory; service failures are surfaced without local fallback. Archived stages do not repeat inference or source requests. Publication can be retried; work interrupted before its Memory commit may repeat. One controller advances a task serially; this example does not supply distributed controller locking.

A request ID is bound to its contents. Changing the question, sources, tenant or configuration requires a new ID. To fetch a newer source version, create a new task; recovery retains archived evidence.

## Results and limits

Reports return `completed`, `no-evidence`, or `partial`. Empty retrieval produces no invented quotations. Source failures block reporting unless `allowPartial: true` and valid evidence remains; partial reports list failed sources. Quotes are checked against archived passages, which proves their presence, not the authority, freshness or independent truth of the source.

Document search uses line-level keyword matching. External knowledge search uses SQLite FTS5; internal knowledge uses the Memory database keyword search. Rewriting and expansion select from a caller-provided controlled vocabulary. Replace the public Retrieval Provider to use another index.

Limits are three document/external candidates per query, twelve configured internal Memory keys with at most one match per key, five search hits with the first allowed result read, two direct pages, and two selected passages per page, each at most 1000 characters. The reader allows configured HTTPS origins, rejects redirects, times out after 20 seconds, and caps responses at 4 MiB. Source data cannot grant permissions.

## Validation

```sh
npm run check
npm run check:examples:retrieval:tasks:package
```

The package gate installs the actual tarball outside the repository, typechecks without `paths`, blocks private Core imports, checks silent entry imports, and runs complete tasks with real models, Redis, SQLite Memory/FTS, files and internet pages. It covers exact citations and locations, expiry, storage failures, killed-process recovery, missing sources, invalid model output and publication retry. Default live tests cover Wikipedia; configure and run Brave separately. SQLite coverage does not imply PostgreSQL/MySQL coverage. Instructions, artifacts, installed dependencies and databases are ignored by Git.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).

The multi-source plan visits sources in order and preserves successful results when an allowed source fails. It does not promise concurrent source requests. Independent operations within a Graph can still run concurrently.
