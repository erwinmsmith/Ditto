# Execution result understanding APIs

[简体中文](observation-workflows.zh-CN.md) · [Worker API](README.md) · [Five examples](../../examples/capabilities/observation/README.md)

Use public `INTERACTION.OBSERVE` to retain result semantics, INFER to interpret business meaning, then Context, Memory and tool nodes to update state and perform follow-ups. Existing APIs support all five capabilities without dedicated Core nodes for each application category.

## Complete invocation

Use Node.js 24+, a real model and Redis configured as described in the [setup guide](../../examples/capabilities/observation/README.md). Save this as `observation-example.ts` at the repository root:

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { ResultTools } from "./examples/_shared/tools/observation/tools.ts";
import { createFixture } from "./examples/_shared/tools/observation/service.ts";
import { sandbox } from "./examples/capabilities/observation/cli.ts";
import { run } from "./examples/capabilities/observation/normalize.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-observation-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-observation-tasks/example-"));
const fixture = await createFixture(directory, "normalize");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new ResultTools(directory, fixture.request);
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
} finally { await fixture.service.close(); }
```

```sh
npm run build
node --env-file=.env observation-example.ts
```

The example reads actual HTTP CSV, passes raw output through OBSERVE to the model, validates extracted fields and calculation, transactionally updates task state and publishes `artifacts/result.json`. Change both the entry and fixture mode to `read`, `errors`, `state` or `interpret` for other workflows.

`run(runtime, { request, model }, options?)` requires only Runtime's public `run` method. `signal` propagates cancellation. `stopAfter: "observed"` pauses after persisting the first tool result; `stopAfter: "decision"` pauses after interpretation but before state update. Pausing returns `{ status: "checkpoint" }`; terminal execution returns a `Report`.

## Results and observations

| Node | Input | Direct output |
| --- | --- | --- |
| `INTERACTION.ACT.TOOL` | `{ call: { id, name, arguments } }` | `ExternalResult` |
| `INTERACTION.OBSERVE` | `{ result: effect }` | `Observation` |

These outputs have no `NodeResult.output` wrapper. OBSERVE retains `callId`, `source`, `status`, `structuredContent`, `error`, `references` and `metadata`. It turns content into a `message` with role `tool` and the source name. The application verifies preservation rather than allowing failure to become success or losing provenance. See the [INTERACTION contract](interaction.md).

OBSERVE normalizes; it does not parse arbitrary CSV, retry tools or mutate Context. The workflow adds its observation using `CONTEXT.UPDATE({ scope, add })`, reloads Redis context and invokes `INFER.REASONING.SAMPLE`. INFER and MEMORY return `NodeResult`: check success and `output` before consuming it. Construction, routing and infrastructure failures may still throw.

## Interpretation and evidence validation

The application model-output contract is:

```ts
interface Decision {
  callId: string;
  orderId: string;
  totalCents: number | null;
  remoteState: "completed" | "failed" | "unknown";
  errorKind: "none" | "transient" | "permission" | "not_found" |
    "timeout" | "transport" | "invalid_output" | "business" | "cancelled";
  nextAction: "complete" | "retry" | "reconcile" | "escalate" | "stop";
  reason: string;
}
```

The model reads actual Observation data, interprets JSON/fixed-format CSV, classifies errors and proposes a follow-up. `validateDecision` independently checks totals, order identity, classification, action and correlation against the original result. Missing/extra fields, invented amounts and forbidden actions fail. External text and error messages are data and cannot override controller policy.

HTTP success does not establish business completion: a business `failed` status produces `needs_review`. Timeout and uncertain transport retain `remoteState: "unknown"` and query remote state first. HTTP 503 permits one idempotent retry; 403/404 do not. Cancellation stops. The budget permits two observation rounds: the initial call and one follow-up. Unresolved outcomes then require review.

## State and follow-up execution

The registered `result_commit` tool transactionally stores the validated interpretation, state and version in the application database. States are `pending`, `waiting_retry`, `reconciling`, `completed`, `needs_review` and `stopped`. Identical round replays preserve the version; conflicting/stale commits fail. `result_retry` and `result_status` also check task state before acting.

`Report` contains `taskId`, mode, final `state`, per-round `{ result, observation, decision }` and `verified: true`. Review and cancellation are validated terminal outcomes, not business success. Reports retain errors and evidence for callers to display or hand to an operator; the example sends no human notifications.

## Checkpoints and databases

Context scope is `observation:<tenant>:<id>`. Public `MEMORY.GET/WRITE` keys append `input`, `observed-0`, `decision-0`, optionally `observed-1`/`decision-1`, and finally `report`. All carry a canonical request fingerprint.

Persist observations before inference and decisions before state updates or follow-ups. Recovery rebuilds Redis from committed results and avoids repeating completed inference. Only `CONTEXT_NOT_FOUND` is treated as a cache miss; unavailable Redis does not fall back to process memory. Unavailable Memory stops progress.

Memory Worker owns `memory.sqlite`; the application owns `tasks.sqlite`; the HTTP service owns `remote.sqlite`. Idempotent events recover state-update crashes. Remote idempotency recovers a crash after an effective retry. These stores are not a distributed transaction, and cancellation/timeout does not prove rollback.

## Installed-package acceptance

`npm run check:examples:observation:tasks:package` installs an npm tarball outside the repository, copies application examples, installs the Redis client, checks strict types without paths aliases, blocks private Core imports and repository fallback, silently imports five entries, and runs 32 full task scenarios. Runtime assembles and executes Workers; business adapters remain outside Core.

Tests use a real model, Redis, HTTP/SQLite, raw CSV, unavailable stores, rejected incorrect interpretations, and process termination after observation, interpretation, state and retry effects. Missing services fail rather than treating mock models or skipped cases as complete acceptance.
