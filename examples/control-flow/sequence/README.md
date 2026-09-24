# 2.1 Sequencing and step execution

[简体中文](README.zh-CN.md) · [Control flow](../README.md) · [All examples](../../README.md) · [Graph API](../../../docs/worker-api/runtime.md#graph-construction-and-execution)

Declare steps and input bindings with Graph, execute stages with Runtime, and repeat a workflow over a batch with Loop.

| Type | Purpose | Example | Public APIs |
| --- | --- | --- | --- |
| Fixed steps | Execute a predefined sequence | [pipeline.ts](pipeline.ts) | `graph().node()`, `runtime.run()` |
| Sequential dependencies | Pass upstream results to dependent steps | [dependencies.ts](dependencies.ts) | `dependencies`, `bind` |
| Staged execution | Finish and validate one stage before entering the next | [stages.ts](stages.ts) | Separate Graphs, sequential `await runtime.run()` |
| Batch execution | Repeat one workflow for multiple objects and aggregate results | [batch.ts](batch.ts) | `loop()`, `runtime.loop()`, summary Graph |

The first two standalone commands use local data. The staged and batch commands call real models. The acceptance command exercises real-model paths for all four types.

## Run

Use Node.js 24+ and npm 11+. From the repository root:

```bash
npm ci
npm run example:sequence:pipeline
npm run example:sequence:dependencies

# Configure the default model and network permissions in .env first:
npm run example:sequence:stages
npm run example:sequence:batch
```

Each command builds `@ditto/core` and runs the example through its public package exports. Each file is self-contained; importing it does not run a task.

## Fixed steps: pipeline.ts

[pipeline.ts](pipeline.ts) loads two items and selects one using the built-in deterministic selector:

```text
loaded: CONTEXT.LOAD → selected: CONTEXT.SELECT
```

`PipelineInput` contains `items`, `query` and `limit`. The `selected` step declares `["loaded"]` and maps that output into SELECT's `context`. The query and limit come from the original graph input.

Default output:

```json
{
  "loadedItemIds": ["graph", "memory"],
  "selectedItemIds": ["graph"]
}
```

`runPipeline(input?)` returns the complete `{ loaded, selected }` results. Changing the query to `memory` selects the other item. Empty input or `limit: 0` produces an empty selection; a negative or fractional limit is rejected by CONTEXT validation.

## Sequential dependencies: dependencies.ts

[dependencies.ts](dependencies.ts) adds an item, selects it and delivers a message combining original item IDs with the selected content:

```text
loaded → updated → selected → delivered
   └─────────────────────────────↑
```

| Step | Node | Direct dependencies | Input source |
| --- | --- | --- | --- |
| `loaded` | `CONTEXT.LOAD` | None | Original `items` |
| `updated` | `CONTEXT.UPDATE` | `loaded` | Loaded context and `additions` |
| `selected` | `CONTEXT.SELECT` | `updated` | Updated context, `query`, `limit` |
| `delivered` | `INTERACTION.OUTPUT` | `loaded`, `selected` | Original IDs, selected content, caller-owned `deliveryId` |

A transitive dependency is not available inside `bind`: `delivered` must explicitly declare `loaded` to read it. Its binding does not receive `updated`. CONTEXT.UPDATE returns a new context, preserving the original loaded result.

The application supplies an in-memory OutputSink that appends messages to this call's `deliveries` collection and returns an `accepted` receipt. It performs no external delivery or persistence.

Default output:

```json
{
  "message": {
    "originalItemIds": ["graph", "memory"],
    "selectedItemIds": ["binding"],
    "selectedContent": ["A bind function maps dependency outputs to the next input."]
  },
  "receipt": {
    "deliveryId": "sequence-dependencies",
    "status": "accepted"
  }
}
```

`runDependencies(input?)` returns `{ loaded, updated, selected, delivered, deliveries }`. `delivered` is the receipt; `deliveries` contains the locally accepted messages. Selected content is delivered as text, with non-string content serialized as JSON. For an external delivery system, assign IDs according to the application's idempotency contract.

## Staged execution: stages.ts

[stages.ts](stages.ts) divides order processing into two Graphs:

```text
preparationGraph: LOAD → SAMPLE (extract order)
                          ↓ validate Order
completionGraph: SAMPLE (calculate total) → OUTPUT
```

`runStages(runtime, input)` awaits preparation, validates `code`, `quantity` and `unitPriceCents`, and passes the resulting `Order` to the completion stage. The second model receives only the prepared order, not the original text. Prices use integer cents; the final code and multiplication result are checked before delivery.

The default order has code `ORDER-731`, quantity 3 and a unit price of 1200 cents:

```json
{ "code": "ORDER-731", "totalCents": 3600 }
```

Invalid preparation prevents the next stage from starting. An incorrect total prevents delivery. The result `{ order, prepared, completed }` includes the stage boundary data, model results and receipt.

## Batch execution: batch.ts

[batch.ts](batch.ts) runs the same `batchItemGraph` for each object:

```text
Loop: item 1 [LOAD → SAMPLE] → item 2 [LOAD → SAMPLE] → item 3 [LOAD → SAMPLE]
      update collects results; done checks completion
                                  ↓
batchSummaryGraph: OUTPUT (all results and total quantity)
```

`runBatch(runtime, input)` accepts `items`, `model` and `deliveryId`. Object IDs must be nonempty and unique. Results retain input order and caller-owned IDs; the model supplies only `code` and `quantity`. The iteration limit is explicitly set to the batch size, including batches larger than the default 32 iterations.

Default output:

```json
{
  "items": [
    { "id": "first", "code": "PICKUP-101", "quantity": 2 },
    { "id": "second", "code": "PICKUP-202", "quantity": 5 },
    { "id": "third", "code": "PICKUP-303", "quantity": 3 }
  ],
  "totalQuantity": 10
}
```

Empty batches bypass Loop and inference, delivering `{ "items": [], "totalQuantity": 0 }`. A failed call, truncated output or invalid result stops subsequent objects and prevents a successful summary. The result `{ results, samples, receipt }` includes per-object results, model records and one combined delivery receipt.

## Application usage

Copy the desired example into an application with `@ditto/core` installed, then call it from your entrypoint:

```ts
import { runPipeline } from "./pipeline.ts";

const result = await runPipeline({
  items: [
    { id: "api", content: "Graph dependencies determine execution order." },
    { id: "storage", content: "Memory stores long-term information." },
  ],
  query: "dependencies",
  limit: 1,
});
console.log(result.selected.selectedItemIds); // ["api"]
```

`pipeline.ts` and `dependencies.ts` also export `pipelineGraph` and `dependenciesGraph` for use with your own `runtime.run(graph, input)`. Register `createContextWorker()` for the pipeline, and additionally `createInteractionWorker({ output })` for the dependency example. Applications manage their own Runtime lifecycle; the `run*` helpers create a Runtime for each call and close it in `finally`.

| Public entrypoint | APIs used |
| --- | --- |
| `@ditto/core/contracts` | `ContextItem` |
| `@ditto/core/runtime` | `graph`, `loop`, `createDitto`, `loadRuntimeConfigFile`, `DittoRuntime` |
| `@ditto/core/worker/context` | `createContextWorker` |
| `@ditto/core/worker/interaction` | `createInteractionWorker`, `InteractionOutputInput` |
| `@ditto/core/worker/infer` | `createInferWorker`, `ModelConfig`, `NodeResult`, `SampleOutput` |

`runStages(runtime, input)` and `runBatch(runtime, input)` use a caller-owned Runtime registered with Context, Infer and Interaction Workers. Supply an OutputSink and close the Runtime in `finally`. Their standalone commands load application configuration and manage cleanup; see the [application call example](README.zh-CN.md#在应用中调用) for complete imports.

The examples do not import `src/`, `dist/` or another example, and require no TypeScript `paths` configuration.

## Real-model end-to-end validation

The [acceptance script](../../../scripts/check-examples-sequence-live.ts) reuses the exported Graphs and run functions. It extends the fixed-step and dependency Graphs with inference through `.node()`, and directly calls `runStages` and `runBatch`:

```text
pipeline:
LOAD → SELECT → INFER.REASONING.SAMPLE → OUTPUT

dependencies:
LOAD → UPDATE → SELECT → OUTPUT (records) → INFER.REASONING.SAMPLE → OUTPUT (model response)
  └─────────────────────────────────→ SAMPLE also reads the original records

stages: preparationGraph → validate Order → completionGraph
batch: Loop [batchItemGraph × 3] → batchSummaryGraph
```

Configure providers, credentials, model names and Sandbox network permissions in `.env` using [`.env.example`](../../../.env.example). Generation budgets and deadlines come from [`ditto.yaml`](../../../ditto.yaml). Run from the repository root:

```bash
# Use the provider selected by DITTO_WORKER_INFER_MODEL_PROVIDER.
npm run check:examples:sequence:live

# Run all four examples for each configured provider in the list.
npm run check:examples:sequence:live -- --provider deepseek,openai,glm
```

Each provider checks all four execution types with seven real HTTP model calls: one fixed-step call, one dependency call, two staged calls and three batch calls, using built-in Workers and providers constructed from configuration. No model doubles or fallback answers are injected.

- **Pipeline:** generate a random pickup code and count alongside unrelated data. Pass only SELECT's output to the model, verify its extracted JSON, and require the final OUTPUT to deliver that exact model response.
- **Dependencies:** generate different original and replacement codes, replacing the item with the same ID through UPDATE. Give the model both the original LOAD result and the latest SELECT result, and verify the original code, current code and current count.
- **Stages:** extract a randomly generated order, then verify the second stage's calculated total.
- **Batch:** infer three distinct records, checking ID correspondence, order, quantities and a single combined summary.
- Check model status, finish reason, structured answers, delivery content and receipts, unchanged inputs, context results and delivery counts. Failed or truncated inference stops final delivery.

The report is written to `.examples-sequence-live-results.json` (Git ignored), containing provider, model, execution ID, elapsed time, usage, expected/actual values and pass/fail results. Use `--report <path>` to change its location. A failed assertion or model call results in a nonzero exit code.

Live validation runs separately from `npm test`: it requires credentials and network access, and incurs model usage charges. Example acceptance requires both deterministic control-flow checks and real-model validation.

## Execution semantics

- `.node()` returns a new Graph; chain calls or retain the returned value.
- Dependencies determine execution order. A concurrency limit of 1 bounds simultaneous work but does not declare data dependencies.
- `bind` synchronously maps the original input and direct dependency outputs to a Node input. Nodes perform the work.
- An exception from an upstream Node or binding stops subsequent scheduling and rejects the run after started branches settle.
- Returned `failed`, `rejected` or `unknown` statuses are ordinary data. Check them explicitly; this example requires an `accepted` OUTPUT receipt.

See the [Runtime API](../../../docs/worker-api/runtime.md) for parameters, Worker bindings and cancellation.

External package acceptance: `npm run check:examples:sequence:package`. See [unified package acceptance](../../../docs/worker-api/control-flow.md) to validate every category against one tarball.
