# Planning and task management through public APIs

[简体中文](planning.zh-CN.md) · [API index](README.md) · [Five examples](../../examples/capabilities/planning/README.md)

The planning examples produce local inventory replenishment reports. A model proposes tasks and tools; application rules validate dependencies, resources, and budgets before constructing an execution graph. All framework calls use exported `@codesoul-co/ditto/...` entries.

## Public API mapping

| API | Use |
| --- | --- |
| `createDitto`, `graph`, `ExecutionGraph`, `DittoRuntime.run` | Register Workers and execute planning, dynamic task, storage, and delivery graphs |
| `createContextWorker({ redis })` / `CONTEXT.LOAD`, `CONTEXT.UPDATE` | Read and update real Redis Context by session scope |
| `createMemoryWorker({ store })` / `MEMORY.GET`, `MEMORY.WRITE` | Archive requests, plans, and results in a database |
| `createInferWorker` / `INFER.REASONING.SAMPLE` | Convert goal, catalog, and constraints into structured plans |
| `createInteractionWorker({ tools, output })` / `INTERACTION.ACT.TOOL`, `INTERACTION.OUTPUT` | Execute business tools, checkpoint results, and deliver reports |

Roles, tool catalogs, reference prices, scheduling rules, SQL ledgers, and file formats belong to the application. See [planning-domain.ts](../../examples/_shared/tools/planning-domain.ts), [planning-store.ts](../../examples/_shared/tools/planning-store.ts), and [orchestration](../../examples/capabilities/planning/shared.ts). No business-specific Core nodes are added.

## Initialize and execute

Install the Redis SDK, start Redis using the [storage guide](../../examples/_shared/tools/storage/README.md), and configure the model. Place this code in the application root; relative imports reference example code copied into the application.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { PlanningStore } from "./examples/_shared/tools/planning-store.ts";
import { createFixture } from "./examples/capabilities/planning/fixtures.ts";
import { runPlan } from "./examples/capabilities/planning/plan.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a model");
await mkdir(".examples-planning-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-planning-tasks/app-"));
await createFixture(directory, "plan"); // Replace with application request and data files.
const storage = await openAgentStorage(directory, config);
const store = new PlanningStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [
    ...storage.workers, createInferWorker(),
    createInteractionWorker({ tools: store.tools, output: store.output }),
  ],
});
try {
  await store.create("plan");
  const planned = await runPlan(runtime, { model: config.model }, { planOnly: true });
  console.log(planned.plan, planned.schedule);
  const completed = await runPlan(runtime, { model: config.model });
  console.log(completed.rows, completed.usage);
} finally {
  try { await runtime.close(); }
  finally { try { await storage.close(); } finally { store.close(); } }
}
```

Resume from the same directory without recreating fixtures or calling `store.create()`. `openAgentStorage(directory, config)` returns `workers`, `redis`, and `close()`, injecting real Redis Context and separate `memory.sqlite` Memory. Applications own SDKs and connections.

## Application contracts

`runPlan`, `runDecomposition`, `runDependencies`, `runBudget`, and `runTools` share this signature:

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { model: ModelConfig },
 options?: { signal?: AbortSignal; planOnly?: boolean }) => Promise<Job>
```

Creation modes are `plan`, `decompose`, `dependencies`, `budget`, and `tools`, respectively. Each directory owns one job. A durable UUID namespace isolates Redis and Memory.

`PlanningStore` is an application controller:

- `create(mode)` reads and validates requests and source files, recording digests and creation time.
- `job()` reads business status, plan, schedule, budget usage, checkpoints, archive acknowledgements, and results.
- `retry(stoppedOwner?)` retains completed checkpoints after repair. Active ownership requires external confirmation that the old executor has stopped. This method is not registered as a model tool.
- `tools` / `output` inject business tools and file delivery into Interaction Worker.
- `close()` closes the business database.

The application authenticates users and authorizes directory access and recovery. UUIDs and owner tokens do not replace authentication. Source paths are application-defined sales and stock files, never model-supplied paths or commands.

## Validate and schedule

Model plans have `{ goal, tasks: [{ id, role, tool, dependsOn, reason }] }` with five distinct roles: `sales`, `stock`, `demand`, `replenish`, and `report`.

`validatePlan(value, request)` checks allowlists, role coverage, unique IDs, dependency existence, data contracts, input readers, and analysis quality. Cycles, self-dependencies, missing prerequisites, and extra tools fail. Input order need not be topological; the scheduler produces execution order.

`schedulePlan(plan, budget)` groups ready tasks into resource-bounded waves. The dynamic graph combines semantic dependencies with wave barriers and runs through `runtime.run(execution, { owner }, { concurrency, signal })`. Each dependent binding checks prerequisite `ExternalResult.status`; the ledger also requires completed prerequisite checkpoints.

Sales and stock can share a wave. Replenishment waits for demand and inventory. A transaction claims each task and reserves calls, cost, and resource capacity before execution. Actual output is checkpointed afterward. Replaying a successful task returns its checkpoint without repeating work or charges.

## Budgets and stopping

`preflight(request)` computes a feasibility lower bound, not an executable substitute for model planning. Impossible required work, permissions, or resources produce `blocked` before inference. Feasible requests reserve a planning attempt and call Sample.

Budgets include `maxModelCalls`, `maxToolCalls`, `maxCostCents`, `maxElapsedMs`, `concurrency`, `ioSlots`, `cpuSlots`, and `memoryUnits`. The application uses fixed catalog prices; model estimates do not authorize execution. Reserved attempts remain charged, so ledger counts can include cancellation before HTTP starts. Experiment reports separately count actual Sample calls.

Execution admission recalculates calls and cost for unfinished tasks. Each tool start and commit checks actual elapsed time. The deadline is creation time plus `maxElapsedMs`, combined with caller cancellation. Timeouts, cancellation, and exhausted budgets stop later commits without rolling back saved checkpoints.

Time estimates combine a fixed model estimate and the longest tool estimate in each wave. They guide selection but cannot guarantee provider latency. Logical resource units bound task concurrency, not OS memory. Reference costs are not provider billing.

## Redis, Memory, and recovery

Requests reach Memory before inference; plans reach Memory before business execution; results are archived after completion and delivery. Keys are `planning:<namespace>:request|plan|result`. The SQLite adapter returns the original record for repeated identical key/content writes and rejects conflicting content.

`prepareContext(runtime, job)` reads the acknowledged archive through `MEMORY.GET`, then loads Redis using `CONTEXT.LOAD({ scope: { sessionId: namespace } })`. Only `CONTEXT_NOT_FOUND` rebuilds the cache from Memory. Other storage failures surface. Business storage is a task ledger, not a Context snapshot fallback.

An interrupted process may leave running checkpoints. After confirming it has stopped, a trusted controller calls `retry(owner)` to preserve completed tasks and retry unfinished work. Budget usage and creation time are not reset. Archive and delivery failures normally only require reentry, without replanning.

`planOnly` persists and presents a plan; it is not an approval system. Actual procurement or other external effects require application authorization and effect-reconciliation tools.

## Package consumer verification

```sh
npm run check
npm run check:examples:planning:tasks:package
```

Verification installs the tarball and Redis SDK outside the repository, typechecks without `paths`, verifies silent imports, and restricts Core entry points. Twenty-nine real task experiments inspect report values, dependency order, calls/cost, Redis values and TTL, Memory records, faults, and process recovery.

Intermediate plans and final reports are actual files. A model response alone does not complete a task. Generated reports, databases, dependencies, and logs are excluded by `.gitignore`.
