# Plan-and-Execute workflows

Use one public `runtime.loop` call to schedule flat stage Graphs: goal and constraints → complete plan → dependency validation → step execution → result check → completion. On a changed environment, generate a new plan for the remaining work. The application owns the domain contract and adapters; Core supplies Graph, Loop, Infer, Interaction, Context and Memory. No additional Core interface is needed for this composition.

## Runnable consumer

Place this file at the consumer root. Copy `examples/patterns/plan-and-execute`, `examples/_shared/tools/plan-execute`, `examples/_shared/tools/storage`, `examples/_shared/tools/evidence.ts` and `examples/_shared/tools/execution/files.ts`. Install the Core tarball and Redis dependency declared in `storage/dependencies/package.json`. Use Node 24, a reachable Redis server and `ditto.yaml` with model credentials supplied through the environment. Set `DITTO_WORKER_CONTEXT_REDIS_URL` to the Redis URL. For retained artifacts, omit the outer cleanup and use a persistent task directory.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/plan-execute/adapters.ts";
import { openPlanExecute } from "./examples/patterns/plan-and-execute/cli.ts";
import { runPlanExecute } from "./examples/patterns/plan-and-execute/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_PLAN_EXECUTE_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-plan-example-"));
try {
  const request = await createDemo(directory, "price-change");
  const app = await openPlanExecute(directory, request, config);
  try {
    const result = await runPlanExecute(app.runtime, {
      request,
      model: { provider, model },
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## Public API composition

| Stage | Public node/API | Contract |
| --- | --- | --- |
| Load/resume | `MEMORY.GET`, `CONTEXT.LOAD` | Fingerprinted task, saved plans, operations and budgets; cache miss rebuilt from Memory |
| Goal and overall plan | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | Complete ordered plan, dependencies, expected postconditions and a justified escalation |
| Execute and observe | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | Scoped tool call and correlated result |
| Verify | `INTERACTION.ACT.TOOL` (`plan_check`) | Hashed evidence must match the committed business operation |
| Checkpoint | `MEMORY.WRITE` / `MEMORY.UPDATE` | Persist before/after model and effect dispatch |
| Replan | `plan_snapshot`, Context, Infer | Fresh state, old plans, completed steps and the failed precondition |
| Output | `plan_publish` | Verified shipment, JSON report, Markdown report |

`runPlanExecuteLoop` is a generator plan. Its reusable helpers yield `graphStep` invocations to the same Loop and share its Graph budget (1024). A Graph contains only Worker nodes. The generator performs no filesystem, database, network or Worker execution. `runPlanExecute(runtime, input, options)` invokes `runtime.loop` once; `Options.signal` cancels execution and `stopAfter: "plan" | "step" | "report"` returns a resumable checkpoint. Resume with the same directory and immutable request, omitting `stopAfter`. The helper types are example application exports, not new `@codesoul-co/ditto` exports.

## Planning and effect contracts

`Request` fixes tenant, principal, order ID, goal, quantity, shipping budget, plan/model-call budget, domain-action budget and elapsed deadline. User preferences guide the planner within these constraints. Scope is `plan-execute:<tenant>:<principal>:<id>`. The model returns `{goal,status,reason,steps}`; each step has `{id,tool,dependsOn,expected}`. IDs are unique per plan. The first step has no dependency and later steps depend on the previous step. This example deliberately uses a linear dependency chain; parallel execution is a separate pattern.

A plan must include every operation remaining from the observed state, including receipt retrieval. Arbitrary tools, arguments, incomplete plans, cycles, reordered steps, duplicated completed work and unaffordable carriers are rejected before execution. An infeasible order may produce a validated `needs-human` plan with no effects. Malformed model plans stop with `invalid-plan`; they are not repaired by silently executing a hardcoded plan.

The reference workflow reserves inventory, packs an order, books a carrier and reads the actual receipt. `price-change` changes the standard rate from 300 to 900 cents during packing. A 500-cent cap then requires an economy replan at 400 cents. `unavailable` makes both rates unaffordable; the reserved and packed order is preserved for human handling. `no-stock` escalates before effects. `lost-response` commits shipping but returns an explicitly simulated unknown result; the next snapshot exposes the committed shipment so the remaining plan contains only receipt retrieval.

The local adapter implements a real SQLite transaction boundary in `business.sqlite`, separate from `memory.sqlite`; it does not contact a production carrier. Operation keys are semantic (`reserve_stock`, `pack_order`, `shipment`, `read_receipt`), independent of plan/step IDs. Shipping is keyed once across both carrier alternatives. Preconditions and prices are checked again inside `BEGIN IMMEDIATE`; a retry reconciles committed receipts instead of booking twice. A real ERP/carrier adapter must preserve these guarantees through server-side idempotency and status reconciliation. This example does not claim a distributed transaction across unrelated services.

## Persistence, limits and publication

- Redis stores Context; file-backed SQLite stores durable Memory. Only `CONTEXT_NOT_FOUND` is rebuilt. Redis/Memory failures propagate; no silent in-memory fallback.
- Model and domain-action counters are reserved before calls and persist across restart/replanning. A crash may consume a reservation without a saved response. `maxPlans` limits actual model attempts, not just successful versions. Scope snapshots, checks and publication are controller operations outside `maxActions` and inside the Loop Graph budget.
- The elapsed deadline includes time paused. It stops admission of new plans/actions; it is not a hard timeout for a call already running. An AbortSignal cancels current runtime work. Synchronous SQLite transactions complete atomically.
- One active runner owns a task directory. A completed report is a verified historical snapshot and replays without more model calls or shipping effects. Publication is immutable and safely retryable; evidence or output conflicts fail visibly.
- Shipping costs and receipt fields come from committed business records, not model prose. `shipment.json`, content-addressed `evidence/*.json`, `output/report.json` and `output/report.md` form the audit trail. Reports retain every accepted plan version, completed step and replan trigger. Partial/human reports do not claim a verified completed shipment.
- The trusted application creates `request.json` and `policy.json`. Every tool rechecks the task fingerprint and principal permission. This local policy file is an integration reference, not an identity provider. Production controllers must supply authenticated identity and protect their storage.

## Acceptance

`npm run check:examples:plan-execute:package -- --provider deepseek` packs and installs the actual tarball outside the repository, checks strict types without path aliases, enforces public import boundaries, checks silent imports, runs real-model tasks and executes the consumer above. The task suite checks actual inventory, receipts, files, Redis expiry/unavailability, Memory failure, permission changes, malformed-plan rejection, cancellation, lost responses, budget/deadline stops, process kills and publication retry. Malformed model outputs and response loss are explicit fault injections. SQLite acceptance does not establish PostgreSQL/MySQL compatibility; inject other databases through public `MemoryStore` and validate them separately.
