# 2.7 Task lifecycle control

[简体中文](README.zh-CN.md) · [Category index](../README.md) · [Public API usage](../../../docs/worker-api/lifecycle.md)

Five examples run a complete release-notice task: read input files, persist business and task state in SQLite, generate a notice through a real model, then check business state and register the notice in the same transaction that completes the task. Every state transition records its timestamp and reason.

## Examples

| Workflow | Entry / export | Behavior |
| --- | --- | --- |
| Task state tracking | [status-tracking.ts](status-tracking.ts) / `runStatusTracking` | Record queued, running, failed and completed states with ordered history |
| Check before execution | [state-check.ts](state-check.ts) / `runStateCheck` | Check readiness before inference and check state/version again before registration |
| Safe stop | [safe-stop.ts](safe-stop.ts) / `runSafeStop` | Prevent later registration after cancellation, deadline, budget exhaustion or an operator stop |
| Scheduled trigger | [scheduled.ts](scheduled.ts) / `runScheduled` | Persist an absolute due time and claim one execution after it arrives |
| Event trigger | [event-triggered.ts](event-triggered.ts) / `runEventTriggered` | Read an actual inbox file, validate and deduplicate its event, then run the task |

All workflows use public `@codesoul-co/ditto` entry points. The database, timer rules, inbox and business tools live in the application adapter [lifecycle-store.ts](../../_shared/tools/lifecycle-store.ts), not a Core scheduling service. Notice registration is an actual local SQLite effect; it does not send email, post external messages or publish content publicly.

## Run

Use Node.js 24+ and configure a model Provider in `ditto.yaml` and `.env` at the repository root:

```sh
npm run example:lifecycle:tracking
npm run example:lifecycle:state
npm run example:lifecycle:stop
npm run example:lifecycle:scheduled
npm run example:lifecycle:event
```

Commands build the package, create independent directories and print `{ directory, result }`. The result includes `job`, `release`, `notice` and `history`. Add `--provider <configured-provider>` to select a provider.

| Command | Default result |
| --- | --- |
| `tracking` | Generate and register a notice; return `completed` |
| `state` | Business starts as `draft`; return `blocked` without inference |
| `stop` | Budget is zero; return `stopped / MODEL_CALL_BUDGET` |
| `scheduled` | Wait until about 250 milliseconds after creation, then complete |
| `event` | No event yet; return `waiting` without inference |

### Check, continue and stop

Reuse the directory printed by the initial command:

```sh
npm run example:lifecycle:state -- --directory /path/to/task --ready
npm run example:lifecycle:tracking -- --directory /path/to/completed-task
```

`--ready` represents a trusted business controller making the same revision executable. The task requires `status=ready` and the revision captured at creation. Withdrawal or a revision change during inference blocks stale registration. Completed tasks do not infer again or register another notice.

```sh
npm run example:lifecycle:stop -- --model-call-budget 1
npm run example:lifecycle:stop -- --model-call-budget 1 --deadline-ms 100
npm run example:lifecycle:event -- --directory /path/to/waiting-task --stop
```

The CLI handles `SIGINT` and `SIGTERM`, passing an `AbortSignal` to Runtime and the model Provider. Cleanup uses an independent, uncancelled call to record the stop. `--stop` is a persistent trusted-controller request that prevents later registration; it does not itself signal another process's in-flight model request. Cancel that invocation's signal as well to interrupt the request.

Cancellation after a committed transaction preserves completion and its effect. The budget counts reserved inference attempts, not billing tokens or guaranteed provider receipt. Failed and stopped tasks do not retry automatically; create a new task or compose the [recovery workflows](../recovery/README.md).

### Scheduled trigger

```sh
npm run example:lifecycle:scheduled -- \
  --due-at 2027-01-15T09:00:00+08:00 --wait-ms 0

npm run example:lifecycle:scheduled -- --directory /path/to/task --wait-ms 60000
```

Use a timezone-qualified ISO timestamp for `--due-at`. The due time is persisted at creation. `--wait-ms 0` checks once. If a wait window ends before the due time, the task remains `waiting`. Reopening reads the same due time; an overdue task can execute immediately.

This is an application-owned, one-shot timer consumer. A background application, process supervisor or existing scheduler must keep it running or invoke it again; it does not wake itself after the process exits. It uses the actual wall clock and short abortable polling intervals, not a millisecond timing guarantee. Concurrent consumers claim execution in a SQLite transaction, so only the owner calls the model.

### Event trigger

```sh
npm run example:lifecycle:event
npm run example:lifecycle:event -- --directory /path/to/task --emit-event --wait-ms 5000
```

`--emit-event` writes a real `inbox/task.json` file before consumption. Alternatively, keep the consumer running and atomically publish this file from an independent application:

```json
{
  "id": "release-ready-001",
  "type": "release.ready",
  "taskId": "task",
  "releaseId": "REL-copy-from-result",
  "revision": 1
}
```

The event must match the task's business ID and revision. Event acceptance and `waiting → queued` occur in one transaction. Identical duplicate IDs may replay; conflicting payloads with the same ID are rejected. Events cannot bypass business checks or restart stopped tasks. Invalid events fail a waiting task with `TRIGGER_INVALID`.

The trusted local inbox has one event slot per task; it is not a general message queue. Email, messaging or webhook adapters should authenticate and authorize sources before converting their events to this contract. These examples do not implement those platform protocols. Terminal tasks no longer scan the inbox.

## State and files

| Stage | Meaning |
| --- | --- |
| `waiting` | Await a due time or event |
| `queued` | Trigger satisfied; ready to claim |
| `running` | Execution claimed and one inference attempt reserved |
| `blocked` | Business state or revision mismatch; may be checked again |
| `stopped` | Cancellation, deadline, budget or operator stop |
| `failed` | Execution failure, invalid result or invalid trigger event |
| `completed` | Notice and completion committed in one transaction |

```text
<task-directory>/
  application.json       # CLI workflow type
  task.source.json       # Initial business input
  lifecycle.sqlite       # tasks / releases / notices / events / history
  inbox/task.json        # Actual event input
  results/task.json      # Exported result snapshot from an invocation
```

SQLite is authoritative. Input files bootstrap the task; subsequent business changes go through the application controller. Poll `store.result(id)` from another connection or process for durable state and ordered history. The exported JSON is a snapshot. Notices use the task ID as their primary key; different task IDs represent distinct business intentions.

Waiting consumers can resume after restart. A process killed while `running` leaves its execution record; ownership is not automatically stolen. Reconcile effects before stopping or applying recovery. External effects require the external system's own idempotency and conditional writes.

## Verification

```sh
npm run check
npm run check:examples:lifecycle:tasks
npm run check:examples:lifecycle:tasks:package
```

The 20 task scenarios cover state tracking and reentry, readiness and revision changes, budgets and deadlines, cancellation before/during inference, operator stops, actual wall-clock scheduling, event production in another process, restart after forced termination while waiting, duplicate/invalid events, concurrent claims, actual SQLite write failure and cancellation after commit.

Models use real HTTP providers. Assertions inspect business tables, history and exported files; reports include execution traces. The package suite installs an `npm pack` tarball outside the repository, typechecks without source aliases, verifies side-effect-free imports, then runs the complete task suite. Reports are `.examples-lifecycle-tasks-live-results.json` and `.examples-lifecycle-package-live-results.json`; artifacts are under `.examples-lifecycle-tasks/`. Offline regressions additionally cover provider exceptions, malformed JSON and truncated responses.
