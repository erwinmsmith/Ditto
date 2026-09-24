# Tool-chain execution

A customer-order task reads customer, order, payment and shipment data, classifies the verified state, updates CRM and delivers a notification. One main Loop composes flat stage Graphs through public Worker nodes. Business tools belong to the application; this workflow requires no new Core API.

## Runnable consumer

Copy `examples/patterns/tool-chain`, `examples/_shared/tools/tool-chain`, `examples/_shared/tools/storage`, `examples/_shared/tools/evidence.ts` and `examples/_shared/tools/execution/files.ts` into a consumer project. Install the Core tarball and the Redis dependency declared in `storage/dependencies/package.json`. Use Node 24, `ditto.yaml`, model credentials and real Redis (`DITTO_WORKER_CONTEXT_REDIS_URL`). Run this from the consumer root. Use a persistent directory and omit the outer cleanup to retain artifacts.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createDemo } from "./examples/_shared/tools/tool-chain/service.ts";
import { createTask } from "./examples/_shared/tools/tool-chain/adapters.ts";
import { openToolChain } from "./examples/patterns/tool-chain/cli.ts";
import { runToolChain } from "./examples/patterns/tool-chain/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider =
  process.env.EXAMPLE_TOOL_CHAIN_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-tool-chain-example-"));
try {
  const demo = await createDemo(directory, "exception", { mode: "parallel" });
  try {
    const request = await createTask(directory, demo.request);
    const app = await openToolChain(directory, request, config);
    try {
      const result = await runToolChain(app.runtime, {
        request,
        model: { provider, model },
      });
      console.log(JSON.stringify(result));
    } finally {
      await app.close();
    }
  } finally {
    await demo.service.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## Composition and contracts

`runToolChain(runtime,input,options)` makes one `runtime.loop(runToolChainLoop, ...)` call. Generator helpers yield stage Graphs through `graphStep`; Graphs contain only Worker nodes. Plans do no direct network, file, database or Worker execution. `openToolChain` registers Infer, Interaction and storage Workers through public exports. These helpers are application exports, not additional Core exports.

| Stage              | Public API / node                                    | Input and output                                                              |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Load and authorize | `MEMORY.GET`, `CONTEXT.LOAD`, `INTERACTION.ACT.TOOL` | Immutable request, principal and local policy                                 |
| Read dependencies  | `INTERACTION.ACT.TOOL`                               | Customer → order → payment / shipment; each result has immutable evidence     |
| Analyze            | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE`            | Verified snapshot → scoped, versioned decision and explanation                |
| Write CRM / notify | `INTERACTION.ACT.TOOL`, `INTERACTION.OBSERVE`        | Canonical payload → committed receipt or classified failure                   |
| Persist            | `MEMORY.WRITE` / `MEMORY.UPDATE`                     | Reads, model samples, budgets, effect results and final report                |
| Verify and deliver | `chain_verify`, `chain_publish` via Interaction      | Fresh business state and receipts → report and delivered-notification receipt |

- **Serial:** customer → order → payment → shipment. Each stage follows its declared dependencies.
- **Parallel:** customer → order → {payment, shipment}. Runtime and Interaction both allow concurrency 4. Analysis waits for both results; CRM → notification remains serial.
- **Conditional:** the same parallel read graph, followed by a Loop branch. Healthy orders produce a verified no-op. Orders requiring attention update CRM and notify. Serial/parallel modes also write a healthy status.

`Request` fixes task/tenant/principal, customer/order/recipient, service origin, goal, mode, two effect permissions and budgets. `Snapshot` binds all reads to the same order revision and checks customer scope and recipient. Pending payment takes priority over delayed shipment; otherwise the order is healthy. The real model explains and classifies this state; deterministic validation rejects wrong identities, revisions, classifications and branches. Model prose cannot become a URL, recipient or write payload. Payloads use fixed templates and validated fields.

## Effects, storage and recovery

The reference tool service runs actual HTTP requests against a separate `business.sqlite`: customer/order tables, CRM, idempotency receipts, request timing and a durable notification inbox. A notification is an actual insertion into this test service's inbox, **not SMTP delivery or a connection to a production CRM**. Tools and the service live under `_shared/tools/tool-chain`; Core gains no business dependency. Replace adapters with authenticated providers for deployment while preserving the receipt, scope and revision contracts. Local `policy.json` demonstrates the trusted-controller boundary, not an authentication service. Keep credentials in application configuration and protect the task directory.

Context uses real Redis; Memory uses file-backed `memory.sqlite`. Expired/missing context is reconstructed from durable reads and decisions. Redis or Memory outages fail visibly without in-memory fallback. SQLite Memory acceptance does not establish PostgreSQL/MySQL compatibility; other stores use the public `MemoryStore` interface.

Before writing, tools reread authorization, query `/operation` with a stable `<task>:crm` or `<task>:notify` idempotency key, and reconcile committed effects. The service validates the exact canonical payload, permissions and current revision, then transactionally commits the effect and receipt. Notification additionally requires the matching CRM receipt. A lost HTTP response after commit is recovered by receipt lookup, including after a process kill before Memory save. This guarantee requires provider-side atomic idempotency or a transactional outbox in a real integration; a client lookup alone cannot guarantee exactly-once effects.

A mixed-version read or stale revision before CRM triggers a new read/analyze round. A changed revision after CRM stops with `state-changed-after-crm`; it retains the committed CRM receipt and does not claim rollback or deliver a stale notice. Retryable notification failures preserve CRM success. Failed independent reads retain successful branch results and stop before inference or writes. Invalid analysis stops without effects. Missing either required permission yields `needs-human` before any write.

The service rechecks state at write time. Completion additionally rereads business state, CRM and notification inbox and compares exact receipts. Evidence checksums are verified before analysis/effects and before publication. Completion is a verified point-in-time observation, not a lock on future business changes. Replaying a terminal report performs no HTTP or model calls and returns that historical result.

## Limits and artifacts

`maxRounds` (1–4) bounds refreshed snapshots; `maxModelCalls` (1–4) and `maxEffects` (0–8) are persisted before admission. `maxEffectAttempts` (1–3) bounds each effect per round. Effect reservations include reconciliation attempts; a crash may consume a reservation without a saved result. Deadline (1–3600 seconds) includes paused time and prevents new reads/model/effect attempts. It is not a hard wall-clock timeout; HTTP calls have a 2-second timeout and callers can cancel active work with `Options.signal`. The Loop also bounds execution at 1024 Graphs.

`stopAfter: "reads" | "analysis" | "crm" | "notification" | "report"` returns a checkpoint. Resume using the same immutable request and directory, without `stopAfter`. Only one active runner owns a task directory. Completed, partial and human-handoff reports are terminal; changing goals, budgets or permissions requires a new task after reconciling existing effects. Checkpoints are the mechanism for continuing unfinished work.

Artifacts include `request.json`, `policy.json`, `evidence/<hash>.json`, `output/report.json` and `output/report.md`. A confirmed notification also writes `output/notification.json`. Reports retain all rounds, decisions, failed attempts, confirmed receipts and consumed budgets. They do not turn unknown outcomes into success. Conflicting output files fail rather than being overwritten; immutable publication can be retried.

## Acceptance

`npm run check:examples:tool-chain:package -- --provider deepseek` installs the actual tarball outside the repository, checks strict public types without path aliases, blocks private/source imports, checks silent imports, runs complete tasks and executes the consumer above. Tests verify actual HTTP overlap and dependency ordering, database effects and inbox delivery, healthy no-op, stale/racing reads, response loss after commit, partial failures, permissions, malformed model output, budgets, Redis expiry/outage, Memory failure, evidence tampering, cancellation, process kills and publication retry. Model-output substitutions are explicitly labeled fault injections; normal scenarios use real model responses.
