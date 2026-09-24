# 3.5 Context capabilities

[中文](README.zh-CN.md) · [Capabilities](../README.md) · [API and invocation](../../../docs/worker-api/context-workflows.md)

Five release handover examples compose public `@codesoul-co/ditto` Workers through Runtime Graphs. Each uses Redis working context, SQLite Memory conversation history and checkpoints, a real model, and an `artifacts/brief.json` deliverable.

| Entry | Operation | Outcome |
| --- | --- | --- |
| [load.ts](load.ts) | Read database history with `MEMORY.GET`, read a document through a tool, initialize `CONTEXT.LOAD({scope,sources})` | Generate a handover from instructions, goal, document and history |
| [select.ts](select.ts) | `CONTEXT.SELECT({scope,purpose:"infer",query,limit:5})` | Five relevant inference items; all 23 items remain cached |
| [assemble.ts](assemble.ts) | Initialize instructions and goal; `UPDATE` adds documents, database history and real HTTP search results with provenance | Use the search result's deployment region and cite its source |
| [compress.ts](compress.ts) | Explicit `INFER` summary, exact evidence validation, `UPDATE`, then `COMPRESS({scope,maxItems:4})` | Keep instructions, goal, document and verified decisions; remove incidental history |
| [update.ts](update.ts) | Produce an initial handover; replace the document using the same ID; infer again | Apply the revised region and rollout percentage; preserve both results |

## Run

Requires Node.js 24+, Redis and a real model configured through `ditto.yaml` and `.env`. SQLite uses Node's built-in driver. The Redis SDK belongs to the application.

```bash
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:context:load
npm run example:context:select
npm run example:context:assemble
npm run example:context:compress
npm run example:context:update
```

The CLI creates randomized tasks and input files under `.examples-context-tasks/`, plus a local HTTP search service. This is a repeatable external-source fixture, not a public search engine. Integrate another provider in the application tool while retaining source validation and network admission. Conversation history is imported through `MEMORY.WRITE`. Checkpoints live in `context:<tenant>:<task>:<stage>` and are not internal knowledge records.

```bash
npm run example:context:compress -- --checkpoint
# Substitute the directory printed by the first command.
npm run example:context:compress -- --directory .examples-context-tasks/cli-XXXXXX
```

`--directory` resumes `request.json` and database state. Add `--serve-fixture` when an incomplete assembly needs its demo search service restarted. A task ID identifies a fixed request and committed input snapshot; changed requests require a new ID. Import an entry's `run(runtime,{request,model},options)` for application use. Imports do not connect or execute.

## Recovery and boundaries

Only `CONTEXT_NOT_FOUND` restores a database checkpoint. Redis and Memory failures surface without local fallbacks. Checkpoints preserve the committed working set and selection view, including summaries and revised documents. A report is committed to Memory before file publication; publishing can retry without repeating inference.

`SELECT` is a read-only view. Before inference the application checks that instructions and the goal survived selection. Selection and token budgets do not enforce authorization. `COMPRESS` performs deterministic pruning; explicit model inference performs semantic summarization. The application rejects summaries that lose approved owner/budget decisions or fabricate evidence. Protected items that exceed the budget cause an error. These fidelity checks target this business schema; other applications must supply their own. Default token estimates are not an exact provider tokenizer.

Use one active controller per task. Redis CAS protects individual context writes; there is no database/Redis transaction. Checkpoints define recovery. Hosts that allow competing controllers must provide a task lock; this example does not promise exactly-once external effects. Documents, search results and history remain data. Tenant identity, directories and search URLs come from a trusted host; scope isolation does not replace authentication.

## Acceptance

```bash
npm run check
npm run check:examples:context:tasks
npm run check:examples:context:tasks:package
```

Acceptance checks real model answers, physical artifacts, Redis TTL, database records, cache expiry for all five modes, SIGKILL recovery, storage failures, insufficient budgets, unsupported summary evidence, CAS conflicts and publication retries. Model fault injection alters a result only after the real call completes.

The package gate installs the actual npm tarball outside the repository, checks strict types without paths aliases, five silent imports and public module boundaries, then runs the complete task suite. Generated artifacts, databases, logs and `AGENTS.md` are Git-ignored. SQLite acceptance does not imply PostgreSQL/MySQL validation.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
