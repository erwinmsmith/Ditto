# 2.3 Parallel execution and aggregation

[简体中文](README.zh-CN.md) · [Control flow](../README.md) · [All examples](../../README.md)

Use public Graph, Runtime, INFER and INTERACTION APIs to process independent order files into persisted orders and consolidated reports. [Filesystem tools](../../_shared/tools/order-files.ts) belong to the application, adding no Core nodes, business logic or third-party dependencies.

## Four workflows

| File / function | Task outcome |
| --- | --- |
| [concurrency-limit.ts](concurrency-limit.ts) / `runParallel` | Independent read → infer → save branches in one Graph; one JSON artifact per order |
| [planning.ts](planning.ts) / `runPlanning` | Model proposes tasks and dependencies from an objective and source catalog; validate/persist the plan, execute its task IDs and deliver a report |
| [fan-out-fan-in.ts](fan-out-fan-in.ts) / `runSummary` | Join depends on every save node, rereads persisted orders and calculates totals before delivery |
| [partial-results.ts](partial-results.ts) / `runPartial` | Isolate source Graphs with Promise.allSettled, retain successful artifacts and describe failures in a completed / partial / failed report |

Imports perform no work. [shared.ts](shared.ts) contains validation and the single-order Graph; [cli.ts](cli.ts) provides configuration and lifecycle setup only.

## Run

Requires Node.js 24+ and npm 11+. Run `npm ci` and configure `.env` Provider credentials, model and network allowlist using the [configuration API](../../../docs/worker-api/configuration.md). Commands explicitly load ditto.yaml and .env and call real HTTP models. File tools use only Node.js standard libraries.

```bash
npm run example:parallel:execution -- --concurrency 2
npm run example:parallel:planning -- --concurrency 3
npm run example:parallel:summary -- --concurrency 3
npm run example:parallel:partial
```

Defaults create actual input files under `.examples-parallel-tasks/cli-*/input/` and retain artifacts under `output/<batchId>/`. The partial example includes one missing source to demonstrate actual read failure and retained successes.

Supply your own manifest with paths relative to its directory. Tools only read files inside that directory:

```json
{
  "sources": [
    { "id": "north", "path": "north.txt", "description": "Independent north order" },
    { "id": "south", "path": "south.txt", "description": "Independent south order" }
  ]
}
```

An order file can contain `Order code ORDER-731; quantity 3; unit price 1250 cents.` Codes are strings, quantities positive integers, and unit prices nonnegative integer cents.

```bash
npm run example:parallel:summary -- --manifest /absolute/path/orders/manifest.json --concurrency 2
```

## Contracts

`BatchInput` contains id, sources (`{ id, path, description }[]`) and model. At most eight unique source IDs are accepted; paths/descriptions must be nonempty and arithmetic must remain within safe integers. Planning additionally requires a nonempty objective and at least one source.

`runParallel` returns `{ orders, output }` in source order without a consolidated report. `runSummary` returns `{ report, receipt, output }`. Planning also returns plan/planning results. `runPartial` returns `{ orders, failures, report, receipt }`.

Reports contain status, successes (source ID/hash, code, quantity, unit price, amount), failures (source ID, code, message), and totals over successes only. Empty batches are completed; batches with failures and no successes are failed. An accepted OutputSink receipt confirms delivery of the report, not success of every business task.

## Scheduling and failure semantics

Execution defaults to Graph concurrency 2; summary and planned execution default to 3. Options `{ concurrency, signal }` are passed to public runtime.run. Concurrency limits active nodes in one Graph, not all application tasks or Worker capacity. Workers must support the selected concurrency.

The planning domain has one independent extract operation per source and a summary dependent on every extraction. Validation rejects unknown operations, invented/omitted/repeated sources, duplicate IDs, invalid/cyclic dependencies and premature joins. It does not silently repair plans or execute model-supplied commands/paths.

A throwing Graph stops scheduling new nodes and drains started nodes before rejecting. Business failure objects are ordinary data, checked explicitly by these examples. Strict execution/summary retains those semantics.

Partial results use a separate runtime.run(orderGraph, ...) per source and standard Promise.allSettled. Up to eight branches run together, sequentially inside each branch; there is no global concurrency scheduler, so this CLI does not accept --concurrency. Cancellation drains started tasks and throws without delivering an ordinary partial-success report. Already saved artifacts are not rolled back.

## Artifacts and retries

```text
<batchId>/
├── plan.json                 # Planning workflow
├── <sourceId>.order.json     # Each successful order
├── report.json              # Summary/partial workflows
└── delivery.json            # Accepted OutputSink delivery
```

Temporary writes and atomic publication preserve immutable artifacts. Identical retries succeed; conflicting content cannot overwrite earlier results. Failures include ARTIFACT_CONFLICT, SOURCE_NOT_FOUND, EMPTY_SOURCE, MODEL_FAILED, INVALID_MODEL_OUTPUT and TASK_EXECUTION_FAILED. Use a new batchId for corrected business inputs.

See [parallel API usage](../../../docs/worker-api/parallel.md) for tool configuration and integration.

## Task-level end-to-end experiments

```bash
npm run check
npm run check:examples:parallel:tasks
npm run check:examples:parallel:tasks:package
npm run check:examples:parallel:tasks:package -- --provider deepseek
```

Thirteen cases exercise random original files, actual tools and real HTTP models:

- Concurrency 1/2: actual Worker call intervals establish overlap and enforce the node limit, without artificial delays.
- Join timing: aggregation starts after branch saves; files/delivery are reread and totals independently verified.
- Planning for two/four sources: validate and persist proposed IDs/dependencies, then verify actual execution uses them.
- Missing/empty files, real invalid model output and artifact conflicts: retain successful files, report failures separately and exclude them from totals.
- All-failed, empty and strict-failure cases; reopen all artifacts after Runtime shutdown.

Package checks install an npm tarball outside the repository, verify strict public type resolution without paths aliases and compatibility with native Node TypeScript, then run the same tasks. They require no package src, copy no credentials and inject no model/tool doubles.

Artifacts remain under `.examples-parallel-tasks/run-*/`. Reports are `.examples-parallel-tasks-live-results.json` and `.examples-parallel-package-live-results.json`, including Provider/model, Worker intervals, Graph/node IDs, maximum active nodes/models, task results and artifact paths. Failed outcomes or concurrency assertions exit nonzero. Offline regressions cover cancellation, invalid model output/plans, idempotency and rejected delivery.
