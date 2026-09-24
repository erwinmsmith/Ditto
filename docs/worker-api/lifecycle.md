# Task lifecycle control: public API usage

[简体中文](lifecycle.zh-CN.md) · [Runtime](runtime.md) · [Five workflows and commands](../../examples/control-flow/lifecycle/README.md)

Applications compose public `graph`, `runtime.run`, `CONTEXT.LOAD`, `INFER.REASONING.SAMPLE` and `INTERACTION.ACT.TOOL`. The application adapter owns task state and execution claims, business revisions, due times, event deduplication and notice registration. Core's cancellation propagation is reused without adding business-task or timer APIs.

## Complete call

Use Node.js 24+. In an application with `@codesoul-co/ditto` installed, copy `examples/control-flow/lifecycle/` and `examples/_shared/tools/lifecycle-store.ts`, preserving relative paths. Prepare `ditto.yaml` and `.env`. These application sources are not Core package exports; the adapter uses only Node.js standard libraries.

The example persists an absolute due time, invokes a real model when due, and registers its notice in the local business table:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { LifecycleStore } from "./examples/_shared/tools/lifecycle-store.ts";
import { createFixture } from "./examples/control-flow/lifecycle/fixtures.ts";
import { runScheduled } from "./examples/control-flow/lifecycle/scheduled.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const directory = await mkdtemp(join(tmpdir(), "ditto-lifecycle-"));
await createFixture(directory, "scheduled");
const store = new LifecycleStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [
    createContextWorker(),
    createInferWorker(),
    createInteractionWorker({ tools: store.tools }),
  ],
});
try {
  await store.create("task", { kind: "time", dueAt: Date.now() + 250 }, {
    modelCallBudget: 1,
    deadlineAt: Date.now() + 60_000,
  });
  const result = await runScheduled(runtime, { id: "task", model: config.model }, {
    waitMs: 2000,
    pollMs: 25,
  });
  console.log({ directory, result });
} finally {
  await runtime.close();
  store.close();
}
```

To resume a waiting task, open its original directory, reconstruct Runtime and invoke the same workflow. Do not recreate fixtures or call `create` again. Completed reentry returns the same business result. A process killed while running is not automatically reclaimed; reconcile its effects and choose an application recovery policy.

## Workflow interfaces

`runStatusTracking`, `runStateCheck` and `runSafeStop` share one execution protocol and signature:

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { id: string; model: ModelConfig },
 options?: { signal?: AbortSignal }) => Promise<Result>
```

`runScheduled` and `runEventTriggered` additionally accept `options.waitMs` and `options.pollMs`. They wait for an application trigger, then use the same execution protocol. The wait window defaults to 60,000 milliseconds, with a range of 0–3,600,000. Polling defaults to 50 milliseconds, with a range of 5–10,000. Ending the window returns `waiting` without cancelling the task. This window bounds trigger waiting, not model execution; use the persisted task `deadlineAt` for the latter.

`Result` includes:

- `job`: task/business IDs, expected revision, stage, reason, trigger, deadline, call budget, reserved attempts, execution owner and timestamps.
- `release`: the business record `{ id, revision, status, title, change }`.
- `notice`: the registered `{ releaseId, revision, title, body }`, or `null`.
- `history`: `{ seq, at, stage, reason }` records ordered by sequence, with Unix millisecond timestamps.

Application execution errors normally persist `failed`; stop conditions persist `stopped`, followed by a full result. Blocked, waiting and terminal states also return normally. Invalid invocation parameters, unknown tasks, inability to persist a terminal state or inability to export a report still throw and need caller error handling.

## State and execution boundaries

```text
manual: queued ─┐
time/event: waiting → queued → running → completed
                  │              ├→ blocked
                  └→ blocked     ├→ failed
                                 └→ stopped
```

Blocked tasks may be checked again; failed, stopped and completed tasks are terminal. Execution proceeds as follows:

1. Read state and skip waiting, terminal or already claimed tasks.
2. In a SQLite transaction, check deadline, business readiness, expected revision and call budget; assign an execution owner, reserve one attempt and enter `running`.
3. Use a public Graph to read the business record, load Context and generate a notice.
4. In the registration transaction, recheck ownership, task state, deadline, business state/revision and source facts in the result.
5. Insert the notice and mark completion in one transaction, then export a result snapshot.

Only one consumer can claim a task. Concurrent invocations seeing `running` return existing state without another inference. Notices are keyed by task ID; distinct task IDs represent distinct business intentions. These guarantees apply to the local SQLite transaction, not arbitrary external APIs.

`modelCalls` counts reserved attempts; cancellation or preparation failure can prevent an attempt from reaching the Provider. `modelCallBudget` is not a token or billing budget. Model output must finish normally, parse as JSON, and preserve the business ID, revision, title and complete change sentence, otherwise no notice is registered.

## Application store and controller

`LifecycleStore(directory)` opens `lifecycle.sqlite` in an existing directory. `<id>.source.json` bootstraps the business object; subsequent state comes from SQLite, not edits to the original file.

| Method | Contract |
| --- | --- |
| `create(id, trigger?, limits?)` | Create a task; manual trigger and budget 1 by default. Limits are `{ deadlineAt?: number, modelCallBudget?: number }` |
| `job(id)` | Read the durable task |
| `business(releaseId)` | Read the business record |
| `result(id)` | Read task, business record, notice and ordered history for status polling |
| `updateBusiness(release)` | Trusted controller update; revisions cannot decrease and content changes require a new revision |
| `requestStop(id, reason?)` | Persist a stop, defaulting to `OPERATOR_STOP`; preserve existing terminal states |
| `acceptEvent(event)` | Validate scope, atomically deduplicate and activate a waiting task |
| `close()` | Close SQLite after Runtime work finishes |

Business updates, operator stops and event production are trusted controller actions, not model tools. The application authenticates and authorizes them. CLI flags `--ready`, `--stop` and `--emit-event` demonstrate this boundary without providing an identity service.

IDs allow 1–64 letters, digits, underscores or hyphens. Revisions are positive safe integers. Titles allow 200 characters, change sentences 1000 and notice bodies 4000. Due times and deadlines are nonnegative safe integers in Unix milliseconds; call budgets are nonnegative safe integers. Business states are `draft`, `ready` and `withdrawn`.

## Safe stop and cancellation

The caller's signal reaches the Graph, tools and actual model Provider. Deadlines use the same cancellation path and are rechecked before committing. Cleanup records `stopped / CALLER_CANCELLED` or `stopped / DEADLINE` through a separate uncancelled call. Long deadlines are checked in bounded intervals to avoid Node's single-timer range limit.

An operator stop may be persisted by another process; the later commit then rejects the old result. The stop record alone does not cancel an HTTP request in another process. Applications can forward the stop to the process holding its `AbortController`.

Cancellation after commit preserves `completed` and its business effect; cancellation is not rollback. Model, parsing or storage failures record `EXECUTION_FAILED`; invalid event input records `TRIGGER_INVALID`. Correlate Runtime traces for detailed execution diagnostics. Result files do not contain provider credentials.

## Time and event triggers

`Trigger` is `{ kind: "manual" }`, `{ kind: "time", dueAt: number }` or `{ kind: "event" }`, fixed at creation. The timer consumer activates only after the actual wall clock reaches the due time. Applications keep the consumer alive or invoke it again; Core does not provide operating-system background wakeup.

Events are `inbox/<taskId>.json` files with this contract:

```ts
interface Event {
  id: string;
  type: "release.ready";
  taskId: string;
  releaseId: string;
  revision: number;
}
```

[emitEvent](../../examples/control-flow/lifecycle/fixtures.ts) validates the event and publishes the full file through a temporary file and atomic rename. Producers write into an application-controlled directory. Consumers validate type, task ID, business ID and expected revision. Canonically identical duplicate IDs may replay; conflicting payloads are rejected. Acceptance and activation occur in one SQLite transaction, and events cannot reactivate stopped tasks.

This file adapter demonstrates an actual event source, not email or messaging protocols. Map authorized platform events into the contract above. The reference inbox has one slot per task and does not implement queue archival, partitioning or acknowledgements.

## Tools and verification

| Tool | Responsibility |
| --- | --- |
| `lifecycle_read` | Read task and business state |
| `lifecycle_activate` | Check time or ingest an actual event file |
| `lifecycle_claim` | Check prerequisites and budget; claim execution transactionally |
| `lifecycle_source` | Verify ownership and read the business record |
| `lifecycle_commit` | Check state, revision, deadline and output; register and complete atomically |
| `lifecycle_finish` | Persist failure/stop without replacing terminal state or another owner's task |
| `lifecycle_report` | Export and return a result snapshot |

Inject tools with `createInteractionWorker({ tools: store.tools })` and explicitly allow their names in the sandbox while preserving configured model network rules. Tools own business atomicity; Core handles Graph scheduling, node calls and cancellation propagation.

The [task suite](../../scripts/check-examples-lifecycle-tasks.ts) covers 20 scenarios with real models, business tables, file events, independent processes and actual time. The [package suite](../../scripts/check-examples-lifecycle-package.ts) installs the npm tarball outside the repository, validates strict public types and silent imports, then runs complete task acceptance. Commands, directories and reports are in the [example guide](../../examples/control-flow/lifecycle/README.md).
