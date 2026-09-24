# 2.5 Errors, failures and recovery

[简体中文](README.zh-CN.md) · [Control flow](../README.md) · [All examples](../../README.md)

Use public Graph, Loop, Context, INFER and INTERACTION APIs to extract an order, reserve stock, create a shipment and recover or compensate after failures. Application checkpoints and the external business ledger live in separate SQLite databases; tools use actual HTTP requests.

## Eight workflows

| File / entry | Behavior |
| --- | --- |
| [retry.ts](retry.ts) / runRetry | Adjust the read byte limit from an actual SOURCE_TOO_LARGE failure; retry within a bound |
| [fallback.ts](fallback.ts) / runFallback | Switch an unavailable primary catalog to an allowed backup; retain business rejections |
| [timeout.ts](timeout.ts) / runTimeout | Abort an HTTP read at its deadline, persist timed-out and prevent subsequent writes |
| [checkpoint-resume.ts](checkpoint-resume.ts) / runCheckpoint | Persist extraction/reservation checkpoints and resume shipment after process restart |
| [pause-resume.ts](pause-resume.ts) / runPause, resumePaused | Pause before external writes; resume only with an order-bound persisted approval |
| [session-resume.ts](session-resume.ts) / runSession | Restore task state and public Context, append a question/answer via CONTEXT.UPDATE |
| [compensation.ts](compensation.ts) / runCompensation | Release stock after a confirmed shipment rejection; retain needs-review if compensation fails |
| [side-effect-check.ts](side-effect-check.ts) / runSideEffectCheck | Query a stable operation key before retrying; reconcile a committed write whose response was lost |

[shared.ts](shared.ts) composes preparation, tool Graphs and fulfillment stages. [recovery-store.ts](../../_shared/tools/recovery-store.ts) and [fulfillment-service.ts](../../_shared/tools/fulfillment-service.ts) are application integrations using Node.js filesystem, HTTP and SQLite libraries. They add no Core nodes or vendor configuration.

## Run

Requires Node.js 24+ and npm 11+. Run npm ci and configure the real model Provider in .env using the [configuration guide](../../../docs/worker-api/configuration.md). Commands explicitly load ditto.yaml/.env. The reference service listens on a random loopback port and performs real inventory transactions.

```bash
npm run example:recovery:retry
npm run example:recovery:fallback
npm run example:recovery:timeout
npm run example:recovery:checkpoint
npm run example:recovery:pause
npm run example:recovery:session
npm run example:recovery:compensation
npm run example:recovery:side-effect
```

Each command creates `.examples-recovery-tasks/cli-*/` and prints directory/result/checkpoint. Defaults demonstrate: a corrected read limit; an HTTP 503 fallback; a 75 ms read timeout; a reserved checkpoint; a paused approval; a restored-context answer; compensated stock; or a dropped reservation response reconciled to completion.

Continue using the printed directory. These commands restart both the application and reference service using their existing databases:

```bash
npm run example:recovery:checkpoint -- --directory /absolute/path/to/cli-task
npm run example:recovery:session -- --directory /absolute/path/to/cli-task
npm run example:recovery:pause -- --directory /absolute/path/to/paused-task --decision approve --actor example-operator
npm run example:recovery:pause -- --directory /absolute/path/to/paused-task --decision reject --actor example-operator
```

After a decision is persisted, rerun the pause command with only --directory to continue, including after a process interruption. A paused task accepts one decision. The application supplies actor after authenticating the caller; the CLI demonstrates decision input. Automated acceptance uses the explicitly named experiment-operator.

## Input and artifacts

Write the original request to `<id>.txt`, then call `await store.create(id, requiresApproval)` on `new RecoveryStore(directory, serviceOrigin)`. Example source:

```text
Fulfillment request. SKU: SKU-731; quantity: 2; delivery address: Dock-North.
```

Order output is `{ sku, quantity, address }`, with integer quantity 1–100 and a nonempty address of at most 200 characters. Task IDs contain at most 64 letters, digits, underscores or hyphens and must be unique within the service ledger; assign a new ID to new business work. Read content must match the fingerprint captured at task creation.

```text
cli-task/
├── task.txt
├── fixture.json             # CLI inputs and reference-service experiment settings
├── tasks.sqlite             # Job, Context, approval and event checkpoints
├── service.sqlite           # Independent inventory/operation/reservation/shipment/request ledger
└── results/task.json        # Readable projection of the durable checkpoint
```

Checkpoint schemaVersion is 1. Revision increments on updates, with job state and events committed in one transaction. JSON artifacts can be regenerated. Recovery uses the database and service ledger, preserving task ID, source material and the same logical business service.

## Semantics

Stages: queued/prepared, reserved, completed, paused/approved/rejected, timed-out, uncertain, compensated, needs-review and failed. Only completed confirms a shipment. Compensated confirms stock release after shipment failure. Uncertain preserves an in-flight or unqueryable operation. Needs-review preserves a failed shipment without confirmed compensation. Completed/compensated/rejected/failed/needs-review reentry returns the saved outcome. Cancellation throws while retaining checkpoints.

Retry defaults to three read attempts (allowed 1–5), starting at 16 bytes (allowed 1–65536). Only retryable SOURCE_TOO_LARGE with an allowed requiredBytes value increases the limit. Missing, changed or empty sources stop. Inference and external writes start only after successful reading.

Fallback defaults to primary then backup, restricted by allowedSources. Only UNAVAILABLE triggers switching; insufficient stock, permissions and invalid responses retain their semantics. This example switches tool data sources while using the configured model Provider.

Timeout defaults to 75 ms (allowed 1–60000) and covers the catalog read. A new Graph persists handling state after deadline cancellation. Caller cancellation remains an exception. Graph drains started nodes, so prompt cancellation requires signal-aware tools; this adapter passes the signal to fetch.

External keys are `<taskId>-reserve`, `<taskId>-ship`, `<taskId>-release`, bound to an order fingerprint. Query states are absent, pending, committed and rejected. Only absent permits submission; response loss triggers reconciliation; committed saves a verified checkpoint; pending/unavailable lookup returns uncertain. The service claims each unique key before asynchronous work. Retrying the same key is idempotent; different parameters conflict. Server-side idempotency also protects races after an absent lookup. Third-party integrations require equivalent durable idempotency, query and parameter-binding contracts.

Only confirmed shipment rejection permits compensation. Release is itself queryable and idempotent. A shipped order cannot be undone by releasing stock. Unknown writes remain uncertain; failed compensation retains needs-review and the active reservation.

Checkpoint recovery skips saved inference and confirmed reservation stages. A committed remote operation missing its local checkpoint is recovered by stable-key lookup. Session recovery loads persisted public Context, adds current state and the new question, validates the model's answer against the saved order/stage, then persists the conversation. Restoring a session performs no inventory or shipment writes.

## End-to-end tasks

```bash
npm run check
npm run check:examples:recovery:tasks
npm run check:examples:recovery:tasks:package
npm run check:examples:recovery:tasks:package -- --provider deepseek
```

Twenty cases exercise random original orders, real HTTP models, the actual local service and two independent SQLite ledgers. They cover adjusted/exhausted/permanent retries; allowed/disallowed fallbacks; business rejection; read timeout/success; caller cancellation; SIGKILL and restart for checkpoints, approvals and sessions; compensation success/failure; lost responses and unavailable reconciliation; pending writes after cancellation; and idempotent completed-task reentry.

Reference-service fault switches produce actual HTTP 503 responses, delays, disconnected sockets and business rejections. Tools still use network requests and database transactions. Assertions verify stock changes, unique effects, request order and durable state, then reopen both databases after shutdown. Models are not replaced. Offline regressions additionally cover invalid model output, changed approval fingerprints and idempotency conflicts.

Package acceptance installs an npm tarball outside the repository, checks strict public types without source paths aliases, verifies imports perform no task work and runs the same cases, plus installed CLI pause/approval/reentry checks. Reports `.examples-recovery-tasks-live-results.json` / `.examples-recovery-package-live-results.json` retain Worker/model records, child PIDs/exit signals and remote ledgers. Artifacts remain under `.examples-recovery-tasks/run-*/`; failed assertions exit nonzero.

See [API integration](../../../docs/worker-api/recovery.md) for complete setup and invocation details.
