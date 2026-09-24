# Parallel execution and aggregation with public APIs

[简体中文](parallel.zh-CN.md) · [Runtime](runtime.md) · [Four examples](../../examples/control-flow/parallel/README.md)

The workflows compose existing Graph dependencies, runtime.run and application tools. Independent nodes can run together; a join declares every save node as a dependency. Model planning, order tools and partial-result handling stay in application examples without new Core nodes or scheduling APIs.

## Application integration

Install the desired @ditto/core version and copy `examples/control-flow/parallel/` plus `examples/_shared/tools/order-files.ts`, preserving relative paths. Prepare ditto.yaml, .env and actual order files, then run this from the application root:

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createOrderFiles } from "./examples/_shared/tools/order-files.ts";
import { runSummary } from "./examples/control-flow/parallel/fan-out-fan-in.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const files = createOrderFiles({ inputDirectory: resolve("orders"), outputDirectory: resolve("reports") });
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: files.tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools: files.tools, output: files.output })],
});
try {
  const result = await runSummary(runtime, {
    id: "orders-today", model: config.model,
    sources: [
      { id: "north", path: resolve("orders/north.txt"), description: "Independent north order" },
      { id: "south", path: resolve("orders/south.txt"), description: "Independent south order" },
    ],
  }, { concurrency: 2 });
  console.log(result.report, result.receipt.artifacts);
} finally { await runtime.close(); }
```

Run `node --env-file=.env app.ts` on Node.js 24+. TypeScript uses NodeNext without repository-source paths aliases. Spread config.sandbox to retain Provider network permissions. Functions such as runSummary are copied application examples, not @ditto/core exports.

## Four entry points

| Function | Contract |
| --- | --- |
| runParallel(runtime, input, options?) | BatchInput and `{ concurrency?, signal? }`; concurrency defaults to 2; returns source-ordered `{ orders, output }` |
| runSummary(runtime, input, options?) | Defaults to 3; join and deliver after all saves; returns `{ report, receipt, output }` |
| runPlanning(runtime, { ...input, objective }, options?) | Validate/persist model-proposed tasks, execute their IDs with default concurrency 3; returns `{ plan, planning, report, receipt, output }` |
| runPartial(runtime, input, { signal }?) | Up to eight independent Graphs collected with Promise.allSettled; returns `{ orders, failures, report, receipt }` |

Runtime is Pick<DittoRuntime, "run"> and remains caller-owned. BatchInput contains id, sources (`{ id, path, description }[]`) and model. Dynamic task IDs use runtime-keyed output maps, while Graph still rejects duplicate nodes and unknown dependencies. Fixed Graph dependency typing remains available.

## Scheduling and failure semantics

`graph<I>(id).node(id, node, dependencies, bind)` defines a static DAG. Each SAMPLE depends on its own read, each save depends on read/SAMPLE, and the join depends on all saves.

runtime.run concurrency limits active nodes in one Graph, not multiple runs globally. Worker capacity also matters: an unavailable Worker can raise NoWorkerAvailableError rather than implicitly queue. The partial example launches up to eight separate sequential Graphs; it adds no generic scheduler.

A throwing Graph stops new scheduling and drains started nodes. Failed INFER NodeResult or INTERACTION ExternalResult values remain business data, checked explicitly along with finishReason, JSON and fields. Promise.allSettled isolates branch rejection so successful siblings can save their artifacts. Cancellation throws without delivering an ordinary partial-success report; existing files are not rolled back.

## Planning contract

The model receives an objective and application source catalog and returns tasks:

```json
{
  "tasks": [
    { "id": "extract_north", "kind": "extract", "sourceId": "north", "dependsOn": [] },
    { "id": "extract_south", "kind": "extract", "sourceId": "south", "dependsOn": [] },
    { "id": "consolidate", "kind": "summary", "dependsOn": ["extract_north", "extract_south"] }
  ]
}
```

Validation requires exactly one task per source, unique IDs, no dependencies between independent extractions, and one summary dependent on every extraction. Only a valid plan is persisted and executed. Paths, tool permissions and executable code never come from model output.

## Application filesystem tools

createOrderFiles({ inputDirectory, outputDirectory }) returns tools, output, batchDirectory and pathFor, without adding Core configuration.

| Tool / adapter | Input and effect |
| --- | --- |
| read_order_source | sourceId/path; read confined UTF-8 files up to 1 MiB, returning text/hash |
| save_order | batchId/sourceId/sourceSha256/record; validate code/quantity/unitPriceCents, calculate totalCents and persist |
| save_parallel_plan | batchId/plan; persist an application-validated model plan |
| build_order_report | batchId/successIds/failures; reread orders, reject duplicate/overlapping IDs, calculate safe totals and save |
| output | Verify message matches report.json, save delivery.json, return accepted and an artifact reference |

Atomic publication never replaces differing content. Identical retries are idempotent; conflicting content fails. Interpret business report.status separately from receipt.status: delivery of a failed report is not business success.

See the [example guide](../../examples/control-flow/parallel/README.md) for commands, artifacts, errors and repeatable tasks. `npm run check:examples:parallel:tasks:package` verifies actual execution overlap, model-plan execution, joins and retained partial results against the installed package.
