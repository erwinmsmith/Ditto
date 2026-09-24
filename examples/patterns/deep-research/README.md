# 4.3 Deep research

[中文](README.zh-CN.md) · [API and runnable consumer](../../../docs/worker-api/research-workflows.md)

Turn a complex question into a bounded, evidence-backed research report: understand the goal → plan and decompose → search and read → identify gaps → search again → cross-check → synthesize → verify and publish.

One main Loop schedules flat stage Graphs through `graphStep`. It owns iteration, conditional follow-up queries, budgets and recovery. Graph nodes use public Context, Memory, Infer and Interaction APIs. Application plans never import Core source, instantiate Workers or call nested runtimes.

## Run

Node 24+, a configured model in `ditto.yaml`/`.env`, and Redis are required.

```sh
npm install
npm install --prefix examples/_shared/tools/storage/dependencies
npm install --prefix examples/_shared/tools/retrieval/dependencies
npm run example:research -- --provider deepseek
npm run example:research -- --provider deepseek --stop-after round
npm run example:research -- --provider deepseek --directory .examples-research-tasks/cli-TASK
```

The default task researches SQLite architecture and write concurrency from actual Internet sources. MediaWiki searches the configured wiki; general web search uses `DITTO_EXAMPLE_WEB_SEARCH_ENGINE=brave` with `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`. CLI accepts `--question`, comma-separated `--origins`, `--references`, and `--cross-check`. Programmatic requests also specify research type, audience, scope and budgets. See the linked API guide for a complete consumer example.

## Research and evidence

The plan contains up to three subquestions. Each round produces a coverage matrix with evidence IDs, unresolved gaps, contradictions and new query suggestions. New queries follow information discovered in actual page text. Repeated queries, no new evidence and resource limits stop the process. Unresolved questions remain visible in the report.

The final synthesis uses exact quotations from selected page snapshots; an additional model pass verifies every claim and coverage, with one repair attempt. Strict cross-checking requires multiple origins and different source text for each answered claim. Different origins do not prove publisher independence. Contradictions retain both sides. Search snippets are never citations; fetch timestamps are not publication dates.

Market, industry, academic, competitive and policy requests share this workflow. It does not supply proprietary datasets, expert domain validation or paywall access. The reader extracts HTML paragraphs; PDF and dynamically rendered sources need separate application tools. Evidence is bounded to 48,000 serialized characters with eight final excerpts; larger studies should be split into bounded tasks.

## Persistence and output

Redis holds active Context; file SQLite holds database Memory for fingerprints, reservations, round schedules, results and the verified report. Cache expiry rebuilds from Memory; unavailable storage raises an error. Request/policy files, immutable HTML/search snapshots and outputs belong to application tools, not Core or Memory.

`output/report.md` contains findings, source quotations, coverage, unresolved issues and the research trail. `output/report.json` includes selected evidence, checks, budgets and stopping reason. Resume the same directory and request; changed requirements require a new task. Completed report publication is idempotent and rechecks authorization and snapshots without new model/network work. One active runner per directory is required.

Reservations precede operations and survive crashes; uncertain interrupted operations may be conservatively charged again. Provider transport retries count within one dispatch, not as new searches. The research time limit covers scheduling and pauses, not final synthesis or total execution; an AbortSignal cancels the enclosing Loop.

## Acceptance

```sh
npm run check:examples:research:types
npm run check:examples:research:tasks -- --provider deepseek
npm run check:examples:research:package -- --provider deepseek
npm run check:examples:research:package -- --provider deepseek --docs-only
```

The package gate installs the tarball outside the repository, uses strict types without aliases, blocks private Core imports and runs the documented consumer. Actual Internet research and controlled HTTP corpus experiments are labeled separately; both use real model inference, Redis and SQLite. The corpus requires discovering an annex name before a later query can retrieve a missing fact. Cases cover corroboration, conflicting/hostile text, gaps, budgets, storage failures, cache expiry, process termination and publication recovery. Artifacts and acceptance reports are git-ignored.

Application tools: [research](../../_shared/tools/research/README.md), [web search](../../_shared/tools/web-search/README.md).

CLI also accepts `--scope`, `--audience`, `--research-type`, `--rounds`, `--searches`, `--pages`, `--model-calls` and `--research-seconds`. New questions use a neutral evidence-based scope unless explicitly overridden.
