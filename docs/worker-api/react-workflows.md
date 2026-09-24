# Durable ReAct tasks

The complete example uses one `runtime.loop(runReactLoop, [input, options])`. A generator schedules reasoning, action and observation Graphs with `graphStep`. Decisions come from native `SampleOutput.actionRequests`, not a hard-coded action sequence. The next model call receives the actual `INTERACTION.OBSERVE` output with matching action IDs.

Copy `examples/patterns/react`, `examples/_shared/tools/react`, `storage`, `evidence.ts`, `execution/files.ts`, `operations/sdk.ts` and `operations/dependencies/package.json` into a consumer. Install `@codesoul-co/ditto`, `redis`, and `playwright` for browser tasks. Configure the model and Redis, then run with Node 24+. Importing modules does not open databases, launch services/browsers or invoke a model.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/react/service.ts";
import { createTask } from "./examples/_shared/tools/react/adapters.ts";
import { openReact } from "./examples/patterns/react/cli.ts";
import { runReact } from "./examples/patterns/react/index.ts";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_REACT_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-react-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-react-tasks/client-"));
const demo = await createDemo(directory, "transient");
let app: Awaited<ReturnType<typeof openReact>> | undefined;
try {
  const request = await createTask(directory, demo.request);
  app = await openReact(directory, request, config);
  const result = await runReact(app.runtime, {
    request,
    model: { provider, model },
  });
  console.log(JSON.stringify(result));
} finally {
  try {
    await app?.close();
  } finally {
    await demo.service.close();
  }
}
```

## Public composition

| Stage    | Public API                                    | Responsibility                                                                                    |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Context  | `CONTEXT.LOAD`                                | Load Redis history; assemble trusted instructions, request, tool messages and controller feedback |
| Decide   | `INFER.REASONING.SAMPLE` with `actions`       | Choose allowed native tool calls or propose a final result                                        |
| Act      | `INTERACTION.ACT.TOOL`                        | Dispatch registered application tools under the sandbox and task policy                           |
| Observe  | `INTERACTION.OBSERVE`                         | Preserve success, failure and uncertain outcome; correlate each tool response                     |
| Persist  | `MEMORY.GET`, `MEMORY.WRITE`, `MEMORY.UPDATE` | Save intent before effects, results, observations, reservations and reports                       |
| Schedule | `loop`, `graphStep`, `runtime.loop`           | Continue, branch, checkpoint or stop; Graph nodes remain flat                                     |

The existing `runReactFlow` is a compact transient convenience flow. It does not provide this application's Redis history, database checkpoints or business verification. This example composes the same public leaves under a main Loop instead of wrapping that helper inside a Graph or importing its implementation. `runReact` and `ReactAdapters` are application example APIs, not new Core service APIs.

## Task contract

The trusted controller supplies `id`, `tenant`, `principal`, `jobId`, `goal`, the fixed service `origin`, `mode` (`inspect` or `recover`), `delivery` (`api` or `browser`) and budgets. Models cannot choose arbitrary URLs, another job or additional tools. Authentication and task policy issuance belong to the host application. The included loopback reference service is an actual SQLite-backed job environment for demonstration, not a production identity provider.

Tools are `job_status`, `job_logs`, `runbook_search`, `job_retry` (recover mode only), and either `job_result` or `job_result_browser`. The latter launches real Chromium, fills the job ID, clicks Find and Download CSV, saves the file and captures a screenshot. The runbook is a local UTF-8 document; replace this search adapter to connect external knowledge services. Browser and HTTP tools share the same goal verifier and ReAct controller. Tool SDKs, permissions, business IO and service lifecycle stay under `_shared/tools`.

Retry requires actual log and runbook evidence for `E_TRANSIENT`. A permanent authorization failure escalates to a human. A task-bound idempotency key is reconciled before every recovery POST; the reference service atomically stores the effect and receipt. Lost responses and process failures cannot be interpreted as rollback. Uncertain outcomes become observations so the model can query status and continue. No messages are sent to operators: `needs-human` is a durable handoff result for the host to route.

## Completion and stopping

The model proposes `{status, summary, totalCents, evidenceIds}`. A trusted tool re-reads business state, validates CSV arithmetic and cited evidence, then emits a verification receipt. Wrong totals or premature completion are returned as controller feedback for another decision. The published summary is a factual rendering of verified business fields; free-form model prose cannot introduce an unverified success claim. Reports retain public actions and observations, not private reasoning.

`maxSteps` (1–20) limits model attempts, `maxActions` (0–20) limits model-selected dispatch attempts, and `maxRepeatedActions` (1–4) limits identical action/result pairs. Counters are reserved before dispatch and survive crashes; uncertain interrupted attempts can conservatively count twice. Controller authorization, verification and publication are separate from the model action count. A model turn is reserved to consume observations before new effects start. Entire action batches are validated before execution. Execution is sequential even when a model requests several actions together.

`deadlineSeconds` (1–1800) limits scheduling from the persisted start time, including pauses; in-flight model/tool calls have their own timeouts. An `AbortSignal` cancels the enclosing Loop and reaches cooperative tools. It does not roll back a remote effect. Outcomes are `completed`, `needs-human`, or `partial`; stop reasons identify success, handoff, step/action limits, no progress, deadline and invalid decisions. Partial reports never claim an unverified amount. External failure text is data and cannot grant authority.

## Checkpoints, storage and artifacts

`runReact(runtime, input, {stopAfter: "decision" | "observation" | "report", signal})` returns a checkpoint or `Report`. Resume the same request and directory; changing scope or budgets requires a new task. One active runner per directory is required; distributed use needs application locking.

Redis stores active Context; file SQLite `memory.sqlite` stores workflow Memory. On Redis expiry, reconstruct history from Memory; unavailable Redis/database raises an error instead of switching to an in-memory substitute. `service.sqlite` is the independent business database. Tool evidence and verification files bind contents by hash; every successful observation is checked when publishing. A saved verified report can be republished without new model calls, network requests or recovery writes.

Outputs are `output/report.md`, `output/report.json`, evidence snapshots, and browser `download.csv`/`browser.png` when requested. Publication is idempotent; occupied or tampered output fails rather than overwriting. `report.json` contains structured decisions, observations, usage, evidence IDs and the verified total.

## Acceptance

The package gate installs the actual npm tarball outside the repository, strictly compiles with no aliases, guards imports, checks silent imports and executes the documentation example. Tests use a real model, Redis, file SQLite, actual HTTP service and Chromium. They verify business state, exactly-once recovery effects, downloaded files and reports, plus uncertain responses, permanent failures, budgets, rejected actions, corrected totals, service policy, storage faults, cache expiry, process termination and publication retry. Fault-injected model outputs are labeled separately from ordinary model-chosen trajectories. These tests exercise a controlled local environment; they do not claim arbitrary third-party websites or production services were tested.
