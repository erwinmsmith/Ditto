# ReAct application tools

[中文](README.zh-CN.md) · [Complete example](../../../patterns/react/README.md)

`domain.ts` validates task scope, native actions, CSV arithmetic and reports. `adapters.ts` registers job status/logs, runbook search, recovery and API/browser result tools. `service.ts` provides a real local HTTP/SQLite job environment with restartable scenarios. These are application integrations, not Core business APIs.

`createTask` binds immutable requests and controller policy. `ReactAdapters.tools` are registered with the public Interaction Worker. `react_authorize`, `react_verify` and `react_publish` are controller-only tools excluded from the model catalog. Tool schemas are supplied to the public SAMPLE node; the Loop validates entire action batches before dispatch.

The service owns `service.sqlite`; the Agent uses Redis Context and separate SQLite Memory via [storage](../storage/README.md). Runbook evidence comes from a real local document. Browser operations reuse [operations/sdk.ts](../operations/sdk.ts) and its Playwright configuration. Install Chromium before using `delivery: "browser"`; browser imports are lazy. API-only tasks require no browser installation.

Recovery is scoped to the requested job and permitted transient error, requires log/runbook evidence, checks a task idempotency key before sending POST and uses a server-side transaction. Unknown results are returned as observations. The demo uses a 400 ms HTTP deadline to make delayed-response scenarios reproducible; choose a suitable transport timeout in an external-service adapter.

Evidence is immutable and content-addressed. Completion re-reads service state and CSV, checks integer arithmetic and evidence, then issues a verification receipt. Publication checks the receipt plus every successful observation against snapshots. It writes Markdown/JSON idempotently and never performs an implicit retry or sends a message.

Provide authenticated controller identity, origin authorization and per-directory locking in the host. The loopback service is not a production identity system. External tool adapters must implement their own authentication, scoped permissions, cancellation and effect reconciliation. See [API details](../../../../docs/worker-api/react-workflows.md).
