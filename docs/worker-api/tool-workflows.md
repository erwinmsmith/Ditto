# Tool and system operation APIs

[简体中文](tool-workflows.zh-CN.md) · [Worker API](README.md) · [Ten examples](../../examples/capabilities/tools/README.md)

Tool selection, argument completion, API calls, database queries, file I/O, code execution, browser and desktop actions, messaging and system writes compose existing public APIs. `INFER.REASONING.SAMPLE` describes native `actions`; `INTERACTION.ACT.TOOL` executes them and `INTERACTION.OBSERVE` records the outcome. These application categories do not require dedicated Core nodes.

## Complete invocation

After [tool environment setup](../../examples/_shared/tools/operations/README.md), save this as `operations-example.ts` in the repository root:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { OperationAdapters } from "./examples/_shared/tools/operations/adapters.ts";
import { createFixture } from "./examples/capabilities/tools/fixtures.ts";
import { sandbox } from "./examples/capabilities/tools/cli.ts";
import { run } from "./examples/capabilities/tools/api.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-operations-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-operations-tasks/api-"));
const fixture = await createFixture(directory, "api");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new OperationAdapters(directory, fixture.request);
    try {
      const runtime = createDitto({
        config,
        sandbox: sandbox(config, fixture.request),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      try {
        const result = await run(runtime, {
          request: fixture.request,
          model: { provider, model },
        });
        console.log(JSON.stringify({ directory, result }, null, 2));
      } finally { await runtime.close(); }
    } finally { adapters.close(); }
  } finally { await storage.close(); }
} finally { await fixture.services.close(); }
```

```sh
npm run build
node --env-file=.env operations-example.ts
```

This starts reference HTTP/SMTP services, registers Redis Context, SQLite Memory and business tools, invokes a real model and publishes `artifacts/operation.json`. Change both the `api.ts` entry and `createFixture(directory, "api")` mode to run another capability. Desktop, browser and code tasks require an Electron graphical session, Chromium and Docker respectively.

`run(runtime, { request, model }, options?)` only requires Runtime's public `run` method. `signal` propagates cancellation; `stopAfter: "plan"` returns `{ status: "checkpoint" }` after persisting the model plan. Normal completion returns a `Report` with `operationId`, `tool`, `value`, `evidence`, `plan` and `verified: true`. Resume with the original input and durable directory.

## Native selection and argument completion

The `planGraph` in [shared.ts](../../examples/capabilities/tools/shared.ts) loads Redis with `CONTEXT.LOAD({ scope })`, then passes its contents to `INFER.REASONING.SAMPLE`:

| Field | Content |
| --- | --- |
| `model` | Configured `{ provider, model }` |
| `messages` | System policy and task information loaded from Redis |
| `actions` | Admitted tools: `name`, `description`, `inputSchema`, `target: { kind: "tool", toolName }` |

`actions` describes tools to the model; it does not execute them. Check `NodeResult.status === "success"` and the presence of `output`, then require `finishReason === "action_request"` and exactly one `actionRequests` entry. Read its `name` and `arguments`, apply `validatePlan`, and commit the admitted plan through `MEMORY.WRITE`. The flow does not parse a prose JSON answer as a substitute for native tool calling.

Selection exposes working order and inventory tools; a payment-status task must select the order tool. Parameter completion supplies country, weight and express service from context to an actual HTTP shipping tool. [domain.ts](../../examples/_shared/tools/operations/domain.ts) owns schemas, limits, controller authorization and destination validation.

## Execution and observation

A [RegisteredTool](interaction.md) supplies `name`, `inputSchema`, `validate`, `effects` and `execute`. `validate` rechecks application policy at the tool boundary. `execute` receives arguments and `WorkerContext`, returning content such as `{ status: "success", structuredContent }`. Use `context.signal` for cancellable work and `context.services.sandbox.assert` for network admission.

The invocation Graph passes `{ call: { id, name, arguments } }` to `INTERACTION.ACT.TOOL`. A dependent `INTERACTION.OBSERVE` node receives `{ result: effect }`. Their results are directly `ExternalResult` and `Observation`, not INFER/MEMORY's `NodeResult.output` wrapper.

Application checks still follow successful execution: database totals, file contents, downloaded CSV, persisted desktop notes, received mail, CRM versions and calculated code output. Only a validated receipt can enter result Memory and the published report. Successful tool transport alone does not establish task completion.

## Persistence and retry semantics

Context scope is `operations:<tenant>:<id>`. Public `MEMORY.GET/WRITE` keys append `input`, `plan`, `result` and `report`. Each record carries a canonical request fingerprint; a changed input cannot reuse the task ID. All Worker access goes through Runtime Graphs; SQLite clients stay inside adapters.

Missing Redis context is rebuilt from Memory; unavailable Redis fails. Resuming a saved result does not repeat model calls or business effects. Failed `NodeResult`, failed `ExternalResult`, failed observation, invalid arguments and incorrect business output block publication. Construction, connectivity, Graph and permission failures can also throw.

Cancellation and timeout do not imply rollback of an external action. Files and desktop notes check content consistency. CRM uses transactional idempotency records; mail retries reconcile the reference inbox by Message-ID. Those receiving-system facilities are not cross-system Runtime transactions or universal exactly-once SMTP guarantees. Production adapters must implement their target system's reconciliation and idempotency policy.

## Package consumption and task acceptance

`npm run check:examples:tools:tasks:package` installs a real npm tarball outside the repository and separately installs application SDKs. Examples use only exported `@ditto/core/runtime`, `@ditto/core/contracts` and `@ditto/core/worker/*` entries. Strict TypeScript has no paths aliases; runtime guards reject private imports and repository fallback. All ten entries import without starting work before the full 40-scenario task suite runs.

Acceptance uses a real model, Redis, file SQLite, HTTP/SMTP receivers, Chromium, a visible Electron window and Docker. It covers expiry, dependency failures, policy rejection, invalid arguments, execution failures, process termination and effect reconciliation. See the [task harness](../../scripts/check-examples-operations-tasks.ts). Third-party dependencies, desktop assets and business services remain application-owned and outside the Core package.
