# Information organization and analysis

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [Public APIs](../../../docs/worker-api/analysis-workflows.md)

Consolidate multiple service specifications into traceable facts, duplicate groups, conflicts, verification results and comparisons. A model extracts fields and exact quotations. Application rules own unit conversion, identity, periods, reference authority, verification and arithmetic.

| Capability | Entry | Result |
| --- | --- | --- |
| Multi-source consolidation | [aggregate.ts](aggregate.ts) | A unified set of records retaining every source and location |
| Deduplication | [deduplicate.ts](deduplicate.ts) | Merge equal object/field/period/normalized-value records while preserving evidence |
| Conflict detection | [conflicts.ts](conflicts.ts) | Distinct values for the same object, field and period; historical versions stay separate |
| Fact checking | [fact-check.ts](fact-check.ts) | Supported, refuted, unverified or disputed relative to controller-approved references |
| Structured extraction | [extract.ts](extract.ts) | Actual text, PDF, HTTP, CSV/XLSX and PNG OCR input processing |
| Information conversion | [convert.ts](convert.ts) | JSON, CSV and Markdown with missing values, verification and provenance |
| Comparative analysis | [compare.ts](compare.ts) | Current supported values and explicit right-minus-left differences |

All seven entries share the complete pipeline and set their own `focus`. They export `run(runtime, input, options?)`; imports never connect storage, start servers or invoke models. Business adapters live in [tools/analysis](../../_shared/tools/analysis/README.md); framework calls use public exports.

## Run

Use Node.js 24+, a real model and Redis. Configure `.env` and `DITTO_WORKER_CONTEXT_REDIS_URL` following [storage](../../_shared/tools/storage/README.md). Install Python, Poppler and Tesseract following [file ingestion](../../_shared/tools/file-ingestion/README.md).

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
export DITTO_EXAMPLE_TOOLS_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
npm run example:analysis:aggregate
npm run example:analysis:deduplicate
npm run example:analysis:conflicts
npm run example:analysis:fact-check
npm run example:analysis:extract
npm run example:analysis:convert
npm run example:analysis:compare
```

Python requires Pillow, openpyxl and ReportLab; speech dependencies are unused. Every command creates a separate task directory and prints `{ directory, result }`.

Fixtures generate random retention/capacity values across ten sources: notes, a paraphrased copy, CSV, XLSX, a two-page reference PDF, a conflicting image, an HTTP page, internal Memory knowledge, an external SQLite record and a historical document. The HTTP publisher is a controlled local fixture, not public internet research. The service plans are fictional.

## Outputs

`artifacts/analysis.json` contains claims, unresolved blocks, normalized groups, duplicates, conflicts, verification and comparisons. `facts.csv` contains object/field/period/value/unit/verification/sources columns; `analysis.md` presents comparisons, quotations and conflicts. `snapshots/<sha256>/source.bin` preserves original bytes or knowledge-record JSON, and `<sourceId>-extracted.json` preserves normalized text with locations.

PDF locations identify page and extracted line; tables identify sheet/row/column; OCR locations identify recognized text lines, not image coordinates. Table cells become readable object/field/value text with original cell locations. Source digest mismatches during parsing stop processing.

## Analysis semantics

The schema covers `retention_days`, `storage_gb` and `support_hours`. Units explicitly use seven days per week and 1000 GB per TB; TiB is not treated as TB. Quotations retain original units.

The trusted controller sets `Source.authority`; the model cannot assign it. Source `origin` tracks ownership independently of authority, so internal or external knowledge is not automatically preferred.

| Verification | Meaning |
| --- | --- |
| `supported` | Matches a consistent reference value for the same object, field and period |
| `refuted` | Disagrees with a consistent reference value |
| `unverified` | No reference value exists; repeated agreement alone does not establish authority |
| `disputed` | Reference values disagree; retain the dispute and do not use the field for numeric comparison |

This checks consistency with designated materials, not universal truth or publisher/signature authenticity. Applications must configure appropriate references and periods. Comparisons use current `supported` values; missing or disputed values/differences are `null`.

Every input block must produce one claim or an explicit unresolved entry. Quotes must contain the matching object, field hint, number and unit and occur exactly in the parsed block. Unclear or negative statements remain unresolved. This is a bounded schema workflow rather than lossless understanding of arbitrary documents. OCR defaults to English; PDF extraction uses the text layer. Scanned PDFs can be converted to images for OCR.

## Storage and recovery

Redis Context carries task context. Database Memory stores `analysis:<id>:request|sources|report` checkpoints. Internal knowledge uses `knowledge:<tenant>:<name>` keys read through `MEMORY.SEARCH` with exact scope and kind/tenant checks. External knowledge uses `RETRIEVAL.SEARCH` against `knowledge-external`. Reports preserve `knowledge-internal` and `knowledge-external`; task archives are never treated as internal knowledge.

```sh
npm run example:analysis:extract -- --sources-only
npm run example:analysis:extract -- --directory .examples-analysis-tasks/cli-XXXXXX
```

Use the printed directory. Archived sources are not fetched or decoded again, so checkpoint resume does not need the fixture HTTP server. If ingestion failed before its commit, `--serve-fixture` restarts that fixture publisher at its saved port; real applications maintain their own sources.

Expired Context is restored from database Memory. Redis/Memory failures surface without local fallback. Uncommitted work may repeat; committed reports retry idempotent publication only. Request IDs bind input, periods and authority; changes require new IDs. Callers serialize execution per task.

## Validation

```sh
npm run check
npm run check:examples:analysis:tasks:package
```

The package gate installs the tarball outside the repository, checks strict types without `paths`, and enforces public Core imports. Complete tasks use real models, Redis, database Memory, actual file parsers/OCR, internal/external knowledge and HTTP pages; assertions inspect delivered reports and parse CSV back independently. Failure cases cover invalid citations, missing blocks, forged authority, absent/conflicting references, storage failures, corrupt files, killed-process recovery and publication retries. Unit doubles do not count as live acceptance. Instructions, dependencies, snapshots, databases and reports are ignored by Git.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
