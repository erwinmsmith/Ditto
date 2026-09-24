# 4.1 RAG document question answering

[简体中文](README.zh-CN.md) · [Patterns](../README.md) · [Public API guide](../../../docs/worker-api/rag-workflows.md)

A complete application from a user question to a grounded, cited answer: understand → construct queries → ingest and retrieve → filter → assemble Redis Context → generate → check citations and grounding → persist and deliver.

The fictional corpus covers enterprise knowledge, policies, product documentation, contracts and reports.

## Run

Use Node.js 24+, an available Redis service, and a text model configured in `ditto.yaml` and environment variables. Install application storage dependencies separately:

```sh
npm install
npm install --prefix examples/_shared/tools/storage/dependencies
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:rag -- --provider deepseek
npm run example:rag -- --provider deepseek --sources product \
  --question 'Atlas 标准版和企业版各支持多少成员，数据保留多久？'
npm run example:rag -- --provider deepseek --sources contract \
  --question '合同 D-204 年费和付款期限是什么？故障是否保证四小时修复？'
npm run example:rag -- --provider deepseek --sources report \
  --question '报告里的本季度收入和同比增长率是多少？'
npm run example:rag -- --provider deepseek --sources handbook,product,internal \
  --question '设备借用要登记什么？Atlas 标准版支持多少成员？内部知识库由谁检查？'
npm run example:rag -- --provider deepseek --sources handbook,conflict \
  --question '借用设备多少天后要重新确认归还日期？两份材料有不一致吗？'
```

Each invocation creates an isolated `.examples-rag-tasks/cli-*` directory and prints its path and result. The bundled material is Chinese; the answer follows the question's language.

```sh
npm run example:rag -- --provider deepseek --stop-after selected
npm run example:rag -- --provider deepseek --directory .examples-rag-tasks/cli-YOUR-DIRECTORY
```

Checkpoint stages: `indexed`, `retrieved`, `selected`, `report`. Resume uses the archived `request.json`; do not combine `--directory` with a new question or source selection. New questions, clarified requests, and source revisions use new task IDs and directories.

## Input and authority

[index.ts](index.ts) exports the application entry `runRag(runtime, { request, model }, options)`. [cli.ts](cli.ts) exports `openRag()` for Worker registration and connection lifecycle.

```json
{
  "id": "question-001",
  "tenant": "demo",
  "principal": "alice",
  "question": "借用设备需要登记什么？",
  "sourceIds": ["handbook"]
}
```

The host controller supplies `tenant` and `principal` from authentication and resolves selected sources against its permission catalog. Never accept client identity fields as authority. The runtime is bound to the full request; mismatches fail before inference. CLI task files are trusted application configuration, not an anonymous upload endpoint.

## Source boundaries

| Kind | Actual source | Purpose |
| --- | --- | --- |
| `document` | UTF-8 `.md` / `.txt` inside the task directory | Normalized user documents |
| `external` | Independent `knowledge.sqlite`, table `articles` | Enterprise/business knowledge; distinct from Memory |
| `internal` | Public `MEMORY.GET` for approved `knowledge:<tenant>:*` keys | Curated long-term knowledge; never task checkpoints |

The demonstration isolates Memory SQLite by task directory. To share long-term knowledge across tasks, the host injects a shared database through the public MemoryStore interface and isolates keys by tenant; isolated demo directories are not an enterprise-wide knowledge repository.

`memory.sqlite` stores internal knowledge and task checkpoints. `corpus.sqlite` is the per-task full-text index. Internal records enter the index only after retrieval through the Memory Worker. Business adapters and vendor dependencies belong in `examples/_shared/tools/rag/`.

To use your own material, create a fresh directory with `request.json`, documents and a trusted `sources.json`, then pass `--directory`:

```json
[{
  "id": "handbook", "tenant": "demo", "readers": ["alice"],
  "title": "设备借用制度", "kind": "document", "ref": "handbook.md"
}]
```

External entries use `kind: "external"` and a `ref` matching a record ID in:

```sql
CREATE TABLE articles (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL
);
```

Catalog and record titles must match. Internal entries use `kind: "internal"`, a tenant-prefixed knowledge key, and an approved Memory record `{kind:"knowledge", tenant, title, text}`. See the API guide for the `MEMORY.WRITE` call.

Normalize PDF, Word and scanned documents with the [document ingestion tools](../../_shared/tools/file-ingestion/README.md) before text indexing. Citations here refer to **normalized text lines**, not original PDF pages. Applications retaining page maps can extend `Chunk` and the ingestion adapter.

## End-to-end stages

| Stage | Action | Validation / persisted state |
| --- | --- | --- |
| Authorization | Resolve selected sources for the authenticated tenant and reader | Denied sources never enter inference |
| Understanding / query | Model identifies intent, facets and 1–3 short keyword queries | Ask about ambiguous references; catalog titles are not conversation history; save `plan` |
| Ingestion | Read documents, external rows and approved Memory records; paragraph/length chunking | Immutable SHA-256 text snapshots, source kind, title, line ranges; save `indexed` |
| Retrieval | Chinese bigrams / Latin word tokens, SQLite FTS5 BM25 | Up to 12 hits per query; union by chunk ID; save `retrieved` |
| Screening | Model selects relevant passages and identifies missing/conflicting facts | At most 8 chunks; retain both sides of conflicts; save `selected` |
| Context | Public `CONTEXT.LOAD` / `CONTEXT.UPDATE` | Maximum 10000 evidence characters; fail explicitly on budget overflow |
| Generation | Answer only from the selected working set | Every factual claim requires an exact quote and selected chunk ID |
| Grounding | An additional model call evaluates claim entailment | Deterministic quote matching plus semantic review; reject unsupported drafts |
| Delivery | Persist report with `MEMORY.WRITE`, then invoke publishing tool | Recheck authority and snapshots; idempotent JSON / Markdown files |

Each model request allows up to 8192 output tokens (which may include reasoning tokens, depending on the provider), at temperature 0. Unfinished output is rejected. Normal supported answers use four model calls: plan, screen, generate, verify. Rejected drafts get one repair with validation feedback, for at most six model calls per run; a second rejection never publishes. Infrastructure failures and incomplete model output propagate immediately. No-hit questions need only planning. Clarification stops before ingestion; no relevant evidence means no fabricated factual answer. Model grounding is an additional quality check, not a correctness proof.

Explicit application budgets: 20 selected sources, 100000 characters and 200 chunks per document, 1600 characters per line, approximately 1800 per chunk, 45000 serialized candidate characters, and 10000 selected evidence characters. These are example limits, not global Core limits.

## Outputs

- `artifacts/answer.md`: user-facing answer, limitations, quotations, locations and source versions.
- `artifacts/answer.json`: `question`, `plan`, `selection`, `evidence`, `answer`, `trace`, `grounding` for UI rendering and inspection.
- `snapshots/<sha256>.txt`: exact source text for validating quoted lines.
- Redis: active working Context. Database Memory: request, plan, indexed sources, retrieval, selection and report checkpoints.

| `answer.status` | Meaning |
| --- | --- |
| `answered` | Supported claims with citations |
| `insufficient-evidence` | Answer supported parts and disclose missing facts; no claims if no evidence |
| `conflicting-evidence` | Cite opposing clauses and request resolution by the source owner |
| `needs-clarification` | Ask a specific question; the controller obtains a reply and creates a new request |

Each claim is `{text, citations:[{chunkId, quote}]}`. Citation metadata is taken from validated evidence, never invented by the model. Markdown escapes source HTML and formatting; frontends must still safely render JSON content.

## Recovery and failure behavior

Expired Redis Context is rebuilt from database checkpoints. Redis/Memory outages fail explicitly without an in-process fallback. A process killed after a durable checkpoint resumes later stages. Saved reports retry delivery without new inference.

The task pins initial source versions. Later edits to original files do not silently replace evidence. Start a new task to ingest changes. Snapshot tampering, changed source identity or revoked access prevents continuation or redelivery. Already delivered files are not automatically destroyed by revocation; the host owns artifact access control, encryption, retention and deletion.

Selected sources are required: failed reads are not treated as empty evidence or a successful partial answer. Invalid citations and failed grounding do not publish. Retrying preserves completed checkpoints. Use one executor per task directory; distributed task locking is outside this example.

## Verification and extensions

```sh
npm run check:examples:rag:types
npm run check:examples:rag:package -- --provider deepseek
npm run check
```

The package gate installs the real tarball outside the repository, copies application adapters, checks strict public API types without path aliases, verifies silent imports and enforces package export boundaries at runtime. Live tasks use a real model, Redis, SQLite and files, including business scenarios, source separation, missing/conflicting evidence, untrusted material, storage faults, invalid citations, unsupported claims, snapshot tampering, revocation, process crashes and cache expiry.

Database coverage here is SQLite / FTS5. It is not PostgreSQL, vector database or vendor-wide certification. Replace the retrieval backend through `RetrievalTargetRegistry` / `RetrievalSearchProvider`, preserving source versions and locators; public vector, hybrid and rerank providers are available. Business question types do not require additional Core node identities.

## Graph / Loop structure

`runRagLoop` defines the full task; `runRag()` invokes `runtime.loop()` once. Planning, retrieval, checkpoints, validation and delivery yield their Graphs through `graphStep`. Reusable synchronous subplans share the same budget. Graphs contain stage-local node dependencies, never child Graphs.

Loop chooses the next Graph from results and checkpoints; a rejected answer yields generation/review Graphs again, at most once. The plan allows up to 1024 Graph executions, with separate tighter model/data budgets. Observe actual execution using `runtime.loop(runRagLoop, [input, options], {onGraph})`. See [Graph / Loop composition](../../../docs/worker-api/graph-loops.md) for contracts and cancellation.
