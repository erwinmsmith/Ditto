# 4.4 ReAct

[中文](README.zh-CN.md) · [API and runnable consumer](../../../docs/worker-api/react-workflows.md)

A complete Agent repeats **decide → act → observe → decide** against a real job environment. It diagnoses an export failure, searches an operational runbook, chooses a permitted recovery action, reads the completed CSV and reports a verified total. Native model tool calls select actions; the application does not prescribe a fixed sequence.

One main Loop schedules flat Graphs for public Context, Memory, Infer, Interaction action and observation nodes. Durable decisions precede effects. Actual success, failure and uncertain outcomes feed the next model call. Completion requires business-state and CSV verification; wrong final totals return as corrective feedback.

## Run

Use Node 24+, Redis and model credentials in `ditto.yaml`/`.env`.

```sh
npm install
npm install --prefix examples/_shared/tools/storage/dependencies
npm run example:react -- --provider deepseek
npm run example:react -- --provider deepseek --scenario disconnect
npm run example:react -- --provider deepseek --scenario permanent
npm run example:react -- --provider deepseek --inspect
```

The browser variant uses actual Chromium form input, clicks, download and screenshot:

```sh
npm install --prefix examples/_shared/tools/operations/dependencies
examples/_shared/tools/operations/dependencies/node_modules/.bin/playwright install chromium
npm run example:react -- --provider deepseek --browser
```

Scenarios: `transient`, `permanent`, `completed`, `disconnect`, `timeout`, `persistent`, `hostile`. Set `--goal`, `--steps` and `--actions` as needed. Pause at `--stop-after decision|observation|report`, then resume with `--directory .examples-react-tasks/cli-TASK`. Changed requirements/budgets require a new task.

## Tools and authority

`job_status`, `job_logs`, `runbook_search`, `job_retry`, and `job_result`/`job_result_browser` perform actual HTTP, document and browser operations. Inspect mode excludes retry. Retry needs observed transient-error and runbook evidence. A task-bound idempotency key is reconciled before POST, and the service commits the business effect and receipt atomically. Lost responses, cancellation and process death do not prove rollback. Human escalation produces a report for the host; it sends no messages.

Only the trusted controller sets job identity, origin, permission and budgets. Tool data cannot grant authority. The included SQLite-backed loopback service is a runnable reference environment, not a production authentication service. External services require application-specific credentials, policies and verifiers. All integrations stay in [application tools](../../_shared/tools/react/README.md), outside Core.

## State and outputs

Redis stores active Context; file SQLite `memory.sqlite` stores decisions, results, observations, reservations and verified reports. `service.sqlite` is a separate business DB. Cache expiry rebuilds from Memory; storage outages fail explicitly. One active runner per task directory is required.

Outputs include `output/report.md`, `output/report.json`, `evidence/`, `verification/`, and browser `download.csv`/`browser.png`. Reports include public actions and observations, not private reasoning. The published summary renders verified business fields. Completed publication replays without new model/network calls or writes to the job service, while rechecking policy and evidence.

Step, action, repetition and scheduling-time limits stop the Loop with an explicit partial outcome. Reservations survive crashes and can conservatively overcount interrupted attempts. The deadline includes pauses and limits scheduling rather than whole-task wall time; use AbortSignal for enclosing cancellation. Controller authorization, verification and publication are separate from the model action count.

The compact Core `runReactFlow` remains available for transient use. This durable application composes its public leaves with a main Loop instead of nesting that helper or reaching into implementation files.

## Acceptance

```sh
npm run check:examples:react:types
npm run check:examples:react:tasks -- --provider deepseek
npm run check:examples:react:package -- --provider deepseek
npm run check:examples:react:package -- --provider deepseek --docs-only
```

Real model, Redis, SQLite, HTTP and Chromium tasks verify business effects, files and reports, including recovery, uncertain outcomes, permanent errors, malformed actions, false totals, budgets, hostile text, storage outages, cache expiry, process termination and publication retry. Model fault injection is explicitly labeled. The package gate installs the tarball outside the repository, checks strict public types without aliases, guards runtime imports and executes the documented consumer. Local reference-environment tests do not claim arbitrary third-party website or production-system coverage. Runtime artifacts and reports are git-ignored.
