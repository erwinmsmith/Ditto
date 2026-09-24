# Error and recovery workflows with public APIs

[简体中文](recovery.zh-CN.md) · [Runtime](runtime.md) · [Eight examples](../../examples/control-flow/recovery/README.md)

Applications compose graph, loop, runtime.run/runtime.loop, CONTEXT.LOAD/UPDATE and built-in inference/interaction workers. Durable tasks, approvals, business idempotency and compensation belong to application adapters.

## Integration

Copy `examples/control-flow/recovery/`, `examples/_shared/tools/recovery-store.ts` and `examples/_shared/tools/fulfillment-service.ts` into an application with @ditto/core installed. Preserve relative paths and prepare ditto.yaml/.env:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { RecoveryStore } from "./examples/_shared/tools/recovery-store.ts";
import { startFulfillmentService } from "./examples/_shared/tools/fulfillment-service.ts";
import { runCheckpoint } from "./examples/control-flow/recovery/checkpoint-resume.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const directory = await mkdtemp(join(tmpdir(), "fulfillment-"));
await writeFile(join(directory, "order-731.txt"),
  "Fulfillment request. SKU: SKU-731; quantity: 2; delivery address: Dock-North.");
const service = await startFulfillmentService(join(directory, "service.sqlite"), [
  { sku: "SKU-731", quantity: 20 },
]);
const store = new RecoveryStore(directory, service.url);
await store.create("order-731");
const runtime = createDitto({
  config,
  sandbox: {
    ...config.sandbox,
    tools: store.tools.map(tool => tool.name),
    network: [...(config.sandbox.network ?? []), service.url],
  },
  workers: [createContextWorker(), createInferWorker(), createInteractionWorker({ tools: store.tools })],
});
try {
  const checkpoint = await runCheckpoint(runtime, {
    id: "order-731", model: config.model,
  }, { stopAfter: "reserved" });
  console.log(checkpoint.stage, directory);
} finally {
  await runtime.close(); store.close(); await service.close();
}
```

Run with Node.js 24+: `node --env-file=.env app.ts`; strict NodeNext types need no source paths aliases. Reopen the same service database, RecoveryStore and Runtime to continue. Call runCheckpoint without stopAfter and without creating the task again. A committed operation missing its local checkpoint is reconciled by key. [CLI examples](../../examples/control-flow/recovery/README.md#run) demonstrate separate invocations.

## Entry points

Common arguments are `runtime: Pick<DittoRuntime, "run" | "loop">`, `input: { id, model }`, and `options?: { signal?: AbortSignal }`. The caller owns Runtime lifecycle.

| Entry | Additional parameters | Return |
| --- | --- | --- |
| runRetry | initialMaxBytes default 16, range 1–65536; maxAttempts default 3, range 1–5 | Job |
| runFallback | allowedSources defaults to primary/backup; nonempty, unique, restricted to those IDs | Job with selectedSource |
| runTimeout | timeoutMs default 75, range 1–60000 | Job; read deadline produces timed-out |
| runCheckpoint | options.stopAfter: prepared or reserved | Job; omit to continue to the final stage |
| runPause / resumePaused | Task created with requiresApproval:true | Job with paused/approved/rejected state |
| runSession | question optional, at most 1000 characters | `{ job, answer: { sku, quantity, stage } }` |
| runCompensation | None | Job; compensated on confirmed release, needs-review on failure |
| runSideEffectCheck | None | Job; uncertain effects require reconciliation |

Job includes schemaVersion, id, revision, stage, sourceHash, order, context, reservation, shipment, approval, requiresApproval, selectedSource and error. Model node status, finishReason, role/content, JSON and order fields are checked before preparation is saved.

Retry uses native Loop: execute a read Graph, inspect code/retryable/requiredBytes in synchronous update, adjust maxBytes only for permitted errors, and return done on success, permanent failure or the attempt limit. maxIterations remains the hard guard. Inference and external writes occur after reading succeeds.

Fallback switches only allowed read-only catalog sources on UNAVAILABLE. It does not hide business rejections or move an uncertain write to another provider.

Timeout combines the local deadline and caller signal for the read Graph. After a local deadline, a new Graph using the caller signal records timed-out. Caller cancellation remains an exception. The adapter also has a ten-second transport cap; the earlier limit ends the request, with transport unavailability reported as a tool error. Graph drains started nodes, so tools must cooperate with cancellation. Aborted client requests may still commit on the remote service.

## Checkpoint and approval adapter

`new RecoveryStore(directory, serviceOrigin)` opens tasks.sqlite inside an existing directory. Supply a credential-free HTTP(S) origin with no path and allow it explicitly in sandbox.network. The adapter checks the origin and disables redirects.

- `await store.create(id, requiresApproval = false)` fingerprints `<id>.txt` and creates a queued task; duplicate creation fails.
- `store.job(id)` reads schemaVersion:1; missing or incompatible checkpoints fail.
- `store.decide(id, "approve" | "reject", actor)` accepts only paused tasks, binding an application-authenticated actor/decision to the order fingerprint.
- `store.tools` returns explicitly registered application tools.
- `store.close()` closes the database after Runtime shutdown.

Job state and events commit in one SQLite transaction. Public Context is serialized with the task. JSON results are a regenerable projection. Resume uses the same task ID, source material and logical service ledger.

Pause flows prepare → paused → application decision → resumePaused. The write tool also enforces approval fingerprints. Missing approval preserves paused; rejection remains rejected. Authentication belongs to the application.

Session recovery loads saved Context, adds the current order/stage and question with CONTEXT.UPDATE, samples an answer, verifies it against the checkpoint, appends it with a second update and persists the conversation. It performs no inventory, shipment or compensation writes.

## Tools

All tools use INTERACTION.ACT.TOOL and take id:

| Tool | Additional arguments / behavior |
| --- | --- |
| recovery_read | Read Job |
| recovery_source | maxBytes; return text/sourceHash or a classified read error with suggested limit |
| recovery_prepare | order, context, sourceHash; atomically save prepared |
| recovery_catalog | source: primary/backup; query HTTP catalog and retain selection |
| recovery_operation | kind: reserve/ship/release; apply:false queries, apply:true submits a stable key |
| recovery_checkpoint | kind, operation; verify committed receipt/fingerprint and save stage |
| recovery_state | stage, error; persist allowed pause/timeout/uncertain/review/failure transitions |
| recovery_context | context, answer; retain restored conversation |
| recovery_report | Reread Job and write results/<id>.json |

Failures may return ExternalResult status or throw. Binders explicitly check status. Successful operation interactions return an Operation; its state:rejected represents business rejection, allowing the application to enter compensation.

## Remote operation contract

The reference HTTP API exposes GET `/catalog/primary?sku=…` or `/catalog/backup?sku=…`, GET `/operations/<key>`, and POST `/reserve`, `/ship`, `/release` with `{ key, order, reservationKey }`.

Stable keys are `<id>-<kind>`. Fingerprints bind kind, normalized order and reservation key. The service records pending before asynchronous work; duplicate keys refer to the same operation and different parameters conflict.

Query states: absent permits submission with the same stable key; pending remains uncertain; committed is verified and checkpointed; rejected preserves the business reason. Service-side uniqueness protects races after absent lookups. Response loss triggers one reconciliation attempt. Unavailable/unconfirmed lookup retains uncertain and a later entry queries again. Confirmed reserved checkpoints skip reservation; completed tasks return their saved result.

Only confirmed shipment rejection permits release. Release is also durable/queryable/idempotent. Success restores stock and records compensated while preserving the original shipment error. Failure retains needs-review. Unknown shipment results do not trigger release; a completed shipment requires a separate business reversal operation.

These properties depend on the external service's unique operation ledger, transactions and query contract. Implement equivalent behavior in third-party adapters; keep SDKs, authentication and vendor configuration outside Core YAML.

## Acceptance

`npm run check:examples:recovery:tasks:package` installs an npm tarball outside the repository and validates strict public types, native TypeScript execution and imports that perform no task work. Twenty experiments then use real models, HTTP operations, SQLite transactions, SIGKILL child processes and reopened ledgers. See [task acceptance](../../examples/control-flow/recovery/README.md#end-to-end-tasks) for reports and retained artifacts.
