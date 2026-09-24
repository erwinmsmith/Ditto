# Execution result understanding

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [API guide](../../../docs/worker-api/observation-workflows.md)

Five entries turn actual tool results into validated interpretations, task state and follow-up actions using public Runtime/Graph APIs. They compose `INTERACTION.ACT.TOOL`, `INTERACTION.OBSERVE`, `INFER.REASONING.SAMPLE`, `CONTEXT.*` and `MEMORY.*`. HTTP, output validation and business state adapters live in [application tools](../../_shared/tools/observation/README.md).

| Capability | Entry | Complete task |
| --- | --- | --- |
| Read tool results | [read.ts](read.ts) | Read structured HTTP order output, retain correlation and provenance, verify the amount and publish a report |
| Parse execution output | [normalize.ts](normalize.ts) | Extract order fields from actual CSV using a model, validate the calculation and publish structured data |
| Identify errors | [errors.ts](errors.ts) | Classify a real HTTP 503, persist retry state, perform one idempotent retry and verify its outcome |
| Update task state | [state.ts](state.ts) | Update state, version and event records from verified remote evidence; synchronize Redis and database Memory |
| Choose follow-up actions | [interpret.ts](interpret.ts) | Reconcile remote status after a timeout and finish without blindly resubmitting work |

## Run

Use Node.js 24+, a configured real model and Redis:

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
```

Set model credentials and `DITTO_WORKER_CONTEXT_REDIS_URL` in root `.env`; select the model in `ditto.yaml`. HTTP and SQLite adapters use Node.js standard libraries and add no vendor SDKs.

```sh
npm run example:observation:read
npm run example:observation:normalize
npm run example:observation:errors
npm run example:observation:state
npm run example:observation:interpret
```

Each invocation prints a `.examples-observation-tasks/cli-*` directory. `artifacts/result.json` contains each round's raw `ExternalResult`, normalized `Observation`, model interpretation and final task state. `verified: true` means the interpretation was checked against evidence; read `state` to distinguish completed business work from `needs_review` or `stopped`.

Pause after the first interpretation is saved, before applying task state, then resume with the printed directory:

```sh
npm run example:observation:errors -- --checkpoint
npm run example:observation:errors -- --directory .examples-observation-tasks/cli-XXXXXX
```

`--provider <name>` selects a configured provider. Resume requires the original directory, input and available original HTTP port. Changed input requires a new task ID.

## Evidence and actions

| Evidence | Classification | Action / state |
| --- | --- | --- |
| Valid matching JSON or CSV success | `none` | Complete / `completed` |
| HTTP 503 | `transient` | Retry once / `waiting_retry` |
| HTTP 403 / 404 | `permission` / `not_found` | Escalate / `needs_review` |
| Timeout / lost connection | `timeout` / `transport` | Query remote status / `reconciling` |
| HTTP success with business status failed | `business` | Escalate / `needs_review` |
| Missing fields, malformed data, wrong order or invalid amounts | `invalid_output` | Escalate / `needs_review` |
| Explicit remote cancellation | `cancelled` | Stop / `stopped` |
| Unresolved after one follow-up | Preserve classification | Stop further work / `needs_review` |

The model reads the actual Observation, not a precomputed interpretation. The application verifies its fields, calculation, correlation and action against original evidence. Invented amounts or inadmissible actions block state updates and publication. Tool output cannot grant permission. Escalation persists review state and an evidence report; it does not send messages to other people.

## Persistence

Redis Context is scoped by tenant/task and updated through `CONTEXT.UPDATE`. Public `MEMORY.GET/WRITE` store input, each observation, each validated interpretation and the final report in a separate `memory.sqlite`. Missing cache can be rebuilt; an unavailable service fails explicitly.

`tasks.sqlite` transactionally stores task state, version and events. Identical repeated commits do not increment the version; conflicting commits fail. A separate HTTP service and `remote.sqlite` retain requests, business status and retry counts. Neither business database replaces Memory Worker.

Persist observations before inference and decisions before state updates or follow-up tools. Remote retries use a stable idempotency key. Timeout and unknown results trigger reconciliation. Cancellation does not guarantee external rollback. Failed publication can resume from the saved report.

## Task acceptance

```sh
npm run check
npm run check:examples:observation:tasks
npm run check:examples:observation:tasks:package
```

The 32 scenarios cover five complete tasks, five Redis expiry recoveries, ten real HTTP/output outcomes, unavailable storage, incorrect model interpretations, cancellation, publication retry and changed input. Process tests send `SIGKILL` after observation/decision checkpoints and after actual state or remote retry effects, then resume and verify database versions, retry counts and published files.

Package acceptance installs an npm tarball outside the repository, checks strict types without paths aliases, blocks private imports, silently imports five entries and runs the whole suite. Missing real-model access, Redis or database services fail instead of skipping tests. Targets are the supplied actual HTTP reference service and SQLite; acceptance does not establish behavior for arbitrary production systems or other databases.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
