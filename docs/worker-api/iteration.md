# Loops and dynamic adjustment with public APIs

[简体中文](iteration.zh-CN.md) · [Runtime](runtime.md) · [Six examples](../../examples/control-flow/iteration/README.md)

Compose graph, loop, runtime.run, runtime.loop and built-in INFER/INTERACTION workers. Plan validation, file retrieval, revision rules, goal checks and budget accounting belong to the application.

## Integration

Copy `examples/control-flow/iteration/` and `examples/_shared/tools/brief-files.ts` into an application with @ditto/core installed, preserving relative paths. Prepare ditto.yaml, .env and the [input directory](../../examples/control-flow/iteration/README.md#run):

```ts
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createBriefFiles } from "./examples/_shared/tools/brief-files.ts";
import { runAdaptive } from "./examples/control-flow/iteration/adaptive-loop.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const directory = await mkdtemp(join(tmpdir(), "release-brief-"));
const files = createBriefFiles({
  inputDirectory: resolve("release-input"),
  outputDirectory: join(directory, "output"),
});
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: files.tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools: files.tools })],
});
try {
  const report = await runAdaptive(runtime, {
    model: config.model, maxRounds: 24, modelCallBudget: 12,
  }, { signal: AbortSignal.timeout(180_000) });
  console.log(report.status, report.reason, files.directory);
} finally { await runtime.close(); }
```

Run with Node.js 24+: `node --env-file=.env app.ts`. Strict NodeNext types need no source paths aliases. The runX functions are application examples; Core exports the composition and Worker APIs. Spreading config.sandbox retains configured model network permissions.

runBounded, runAdaptive, runImprovement, runRetrieval, runGoalCheck and runStopConditions share this signature:

```ts
(runtime: Pick<DittoRuntime, "run" | "loop">,
 input: { model: ModelConfig; maxRounds?: number; modelCallBudget?: number },
 options?: { signal?: AbortSignal }) => Promise<BriefReport>
```

Both application limits default to 24 and accept integers from 0 to 100. BriefReport is `{ status: "completed" | "stopped", reason: "goal" | "blocked" | "round-limit" | "budget", rounds, modelCalls, snapshot }`. Snapshot retains requirements, source catalog, draft, evidence values/source IDs/SHA-256, attempts, revision, missing evidence and unresolved fields.

## Native Loop semantics

```ts
const definition = loop({
  graph: (state: State) => chooseGraph(state),
  maxIterations: 24,
  bind: (state: State) => ({ state, model }),
  update: (state, output): State => nextState(state, output),
  done: (updatedState, output) => shouldStop(updatedState, output),
});
const finalState = await runtime.loop(definition, initialState, {
  signal,
  concurrency: 1,
  workers: { "brief-search": { searched: "interaction-worker" } },
});
```

The application implements chooseGraph, nextState and shouldStop with consistent state/Graph types. Optional workers placement maps Graph IDs and node IDs to registered Worker IDs.

Each iteration selects a Graph, binds input, awaits the full Graph, updates state, then checks done. Selection, bind, update and done are synchronous; asynchronous checks and persistence belong in Graph nodes. done receives updated state and the iteration output. Candidate Graphs need a common input/output contract; these examples consume their shared recorded output.

Loop always executes at least once. Check zero budgets/rounds, empty goals and already-complete inputs before calling it. Native maxIterations is a positive safe integer, resolved from the definition, then runtime.loopMaxIterations config, then 32. If done remains false at the limit, Loop throws. Examples return done for normal application stop conditions and record the reason while retaining the native hard guard.

Signal reaches each Graph and is checked at iteration boundaries. Exceptions stop subsequent iterations. Concurrency limits active nodes within each Graph; Loop iterations are sequential. State belongs to the caller; application tools write durable artifacts.

## Plans and acceptance

The model can propose only:

```json
{ "kind": "search", "field": "code", "sourceId": "release" }
```

```json
{ "kind": "repair", "field": "code" }
```

Search requires missing evidence and an untried catalog source covering that field. Repair requires an unresolved field with evidence. Paths and arbitrary operations are not model inputs to execution. Validated actions are persisted and select the next native Graph. Failed lookups retain found:false and feed the next plan with attempts and remaining candidates. Revision responses contain `{ patches: { field: value } }` for exactly the requested fields.

After saves, the checker rereads state and source hashes. Completion requires evidence for every field and exact draft/evidence equality. An incorrect revision can be saved, rejected by the checker and retried until completion or a stop condition; model self-assessment has no authority over acceptance.

Iterative retrieval uses exact field queries over application-owned structured records. A search service or vector store can replace this RegisteredTool; [CONTEXT.SELECT / RAG](context.md) provides Core context-retrieval composition APIs.

## File adapter

`createBriefFiles({ inputDirectory, outputDirectory })` returns `{ tools, directory, inspect }`. The parent output directory must exist; brief_open exclusively creates outputDirectory. Configuration, files and dependencies remain outside Core.

| Tool | Arguments and effect |
| --- | --- |
| brief_open | `{}`; validate spec.json, import initial evidence and save original draft/state |
| brief_search | `{ field, sourceId }`; read a confined source, record success/missing lookup and retain evidence/hash |
| brief_patch | `{ patches: { field: value } }`; update unresolved fields with evidence, increment revision and save |
| brief_check | `{}`; reread state and sources; compute missing, issues, complete and blocked |
| brief_record | `{ round, action, modelCalls, next }`; next is a validated action or null; save a non-overwritable checked round |
| brief_finish | `{ reason, rounds, modelCalls }`; check actual files again and write brief.md/result.json |

Tools run through INTERACTION.ACT.TOOL and return ExternalResult. Binders explicitly check status. Inference additionally validates NodeResult status, finishReason, message role/content, JSON and allowed actions/fields. Errors reject execution while preserving saved revisions and round records.

## Budgets and stop precedence

Application precedence is goal, blocked, round-limit, budget. Only goal means completed. Blocked means at least one missing field has no remaining source. Budget units are Sample node calls reserved before the next round: one for planning/revision, zero for a separate file search. They do not measure Provider-internal HTTP retries, tokens or currency.

All execution rounds count, including dynamic planning and final composition after retrieval. Evidence coverage ends retrieval, but a document still needs to be composed and checked; exhausting the budget between stages returns stopped/budget.

See the [examples](../../examples/control-flow/iteration/README.md) for input formats, commands and seventeen task experiments. `npm run check:examples:iteration:tasks:package` validates installed public APIs, real models, actual file tools, durable outcomes and stop conditions.
