# Content processing

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [API guide](../../../docs/worker-api/content-workflows.md)

Seven public Runtime/Graph workflows read source files, invoke a real model, validate content, perform a separate model review and deliver files. Context uses Redis; Memory Worker stores checkpoints in SQLite. File and rendering adapters remain in [application tools](../../_shared/tools/content/README.md).

| Capability | Entry | Task and acceptance |
| --- | --- | --- |
| Generation | [generate.ts](generate.ts) | Create a new pilot announcement retaining product, date, quota, approval and export restrictions |
| Rewriting | [rewrite.ts](rewrite.ts) | Rewrite a conversational draft as a clear, polite team announcement without losing facts |
| Summarization | [summarize.ts](summarize.ts) | Summarize sources and lengthy meeting notes within 380 body characters, omitting repeated discussion |
| Expansion | [expand.ts](expand.ts) | Preserve the original lead exactly and add source-supported setup and application instructions |
| Translation | [translate.ts](translate.ts) | Translate Chinese to English, retaining identifiers, ISO dates, numbers, restrictions and glossary terms |
| Format conversion | [convert.ts](convert.ts) | Preserve the draft title, paragraph text and order while producing structured JSON, Markdown and HTML |
| Citation generation | [cite.ts](cite.ts) | Create a guide with multiple sources, exact quotes, original lines and snapshot hashes |

## Run

Use Node.js 24+, Redis and a real model. Root `ditto.yaml` / `.env` configure the model; `DITTO_WORKER_CONTEXT_REDIS_URL` configures Redis.

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
npm run example:content:generate
npm run example:content:rewrite
npm run example:content:summarize
npm run example:content:expand
npm run example:content:translate
npm run example:content:convert
npm run example:content:cite
```

Each CLI invocation creates a dedicated `.examples-content-tasks/cli-*` directory containing demonstration product sources, a draft and meeting notes. These are test data, not real product promises. `--provider <name>` selects a configured model.

Pause after saving a validated draft, then resume review and delivery with the printed directory:

```sh
npm run example:content:translate -- --checkpoint
npm run example:content:translate -- --directory .examples-content-tasks/cli-XXXXXX
```

A task ID identifies fixed input and source hashes. Changed requirements or sources require a new task.

## Delivery

Every mode publishes:

- `artifacts/content.json`: title, language, sections, per-section citations and resolved references.
- `artifacts/content.md`: content, source links and original quotes.
- `artifacts/content.html`: escaped static content with links to source explanations.
- `artifacts/review.json`: review verdict.
- `artifacts/sources/*.md`: the exact source snapshots used for generation.
- `artifacts/manifest.json`: file SHA-256 hashes and byte counts.

The model does not choose output paths or generate executable HTML. The application renders structured content, copies snapshots and reads outputs back. Source lines and hashes are calculated by code. Conversion specifically verifies verbatim paragraph preservation; other modes enforce their transformation requirements.

## Validation and recovery

Initial reads validate file type, size and controller-provided hash; symlinks and changed sources fail. After Memory commits material, recovery uses that snapshot even if working files change.

Generation and review make separate real model calls. Application checks enforce schema, language, length, protected facts, numbers, exact quotes and source coverage. Model review checks factual fidelity, coverage, transformation and whether citations support claims. Rejection prevents publication. Automated review is not a substitute for human editing or external verification of the source's truth.

Public `MEMORY.GET/WRITE` persist `input`, `material`, `draft`, `review` and `report`. Redis expiry rebuilds from committed material/drafts; unavailable Redis or Memory fails without an in-process fallback. Identical publications are idempotent; conflicting files fail. Removing a conflicting output permits resume without regenerating committed drafts or reviews.

Truncated or invalid model output is rejected instead of publishing partial text. Generation/review set `generation: { temperature: 0, maxTokens: 8192 }`; mode-specific character limits still constrain the body.

## End-to-end acceptance

```sh
npm run check
npm run check:examples:content:tasks
npm run check:examples:content:tasks:package
```

The 32 scenarios cover seven complete tasks, seven Redis expiry recoveries, missing/symlink/changed files, committed snapshot recovery, unavailable stores, changed input, incorrect numbers/language/citations, lossy conversion, review rejection, partial publication failure, cancellation and process recovery.

Process tests send `SIGKILL` after material, draft or review commits, and after actual publication. A new process resumes and verifies model-call counts, Memory, content, reference lines and hashes. Package acceptance installs an npm tarball outside the repository, checks strict types without paths aliases, enforces public import boundaries, silently imports seven entries and runs the whole suite. Missing real-model access or Redis fails rather than skipping a capability.

For expansion, the application preserves the original lead verbatim from the committed snapshot. The model generates only additional sections; the assembled draft is validated and reviewed as a whole.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
