# Result tools and reference service

[简体中文](README.zh-CN.md) · [Application tools](../README.md) · [Five workflows](../../../capabilities/observation/README.md)

Application result reading, state updates and follow-up tools using Node.js 24 HTTP, SQLite and filesystem APIs. No new vendor SDKs are required; Redis and Memory reuse the [storage adapters](../storage/README.md). Register `adapters.tools` with `createInteractionWorker` and execute through Runtime Graphs.

| File | Responsibility |
| --- | --- |
| [domain.ts](domain.ts) | Request and strict CSV/structured evidence validation, error/action policy, budget and Observation integrity |
| [tools.ts](tools.ts) | `ResultTools`: HTTP results, transactional task state and immutable report publication |
| [service.ts](service.ts) | Actual HTTP reference service, separate SQLite business state, fixture creation and restart |

## Tools

`result_read` requests output, `result_retry` performs an idempotent POST and `result_status` queries business state. They return public `ExternalResult` values with raw JSON/CSV, structured fields, references and HTTP metadata. HTTP 403/404/503, explicit remote cancellation, timeout and connection loss map to structured outcomes. Unexpected programming errors still throw.

The controller configures the HTTP origin; the model cannot supply URLs. Tools check tool/network permission, reject redirects and cap responses at 16 KiB. This example uses a 150 ms result deadline; the timeout fixture commits business completion before delaying its response by 600 ms. Production adapters should choose deadlines for their target service's latency.

`result_commit` revalidates the interpretation against the original result and transactionally updates `tasks.sqlite`. Identical round replays preserve the version; conflicting or stale commits fail. Follow-up tools must match `waiting_retry` or `reconciling` task state.

`result_publish` accepts terminal-state reports and writes `artifacts/result.json`. Replaying identical content is safe; conflicting content fails. It sends no messages and does not contact a human assignment service.

## Boundaries

Public Memory Worker manages `memory.sqlite`; the application owns `tasks.sqlite`; the HTTP service owns `remote.sqlite`. They persist independently and do not replace one another.

The reference service derives its retry idempotency key from the task ID and atomically changes the retry count from zero to one. Timeouts, lost connections and caller cancellation do not guarantee rollback. Caller cancellation propagates; uncertain remote outcomes are interpreted, validated and reconciled.

CSV uses the fixed columns `orderId,quantity,unitCents,status`; this is a business-protocol parser rather than a general CSV importer. Success requires a matching order, positive integer quantities/prices and a safe integer total. Model correlation, amount, classification and action must agree with raw evidence. Tool text cannot grant authorization.

Use a dedicated directory per task. Close Runtime, ResultTools, Memory/Redis and HTTP resources. Importing modules does not connect services, open databases or invoke models. Generated artifacts and test reports are Git-ignored.
