# Conditions and routing with public APIs

[简体中文](routing.zh-CN.md) · [Runtime API](runtime.md) · [Six examples](../../examples/control-flow/routing/README.md)

Routing is application orchestration. A Graph is a static DAG without implicit conditional edges. Ordinary application conditions select the plan passed to `runtime.run(plan, input)`. A join lists all upstream IDs in the downstream node's dependencies. For state-based selection between iterations, use `loop({ graph: state => plan, bind, update, done, maxIterations })`.

## Public entry points

| Entry point | API | Purpose |
| --- | --- | --- |
| `@codesoul-co/ditto/runtime` | `graph<I>(id)`, `.node(id, node, dependencies, bind)` | Static dependencies and input mapping; bind receives only declared dependency outputs |
| `@codesoul-co/ditto/runtime` | `createDitto`, `runtime.run`, `runtime.close` | Worker registration, selected graph execution and cleanup |
| `@codesoul-co/ditto/runtime` | `loadRuntimeConfigFile(path, env)` | Explicit YAML/environment loading; does not load `.env` implicitly |
| `@codesoul-co/ditto/worker/infer` | `createInferWorker`, `ModelConfig`, `NodeResult<SampleOutput>` | Real inference, completion status and usage |
| `@codesoul-co/ditto/worker/interaction` | `createInteractionWorker`, `RegisteredTool`, `OutputSink` | Application tools, delivery and receipts |

Functions such as `runStateRouting` are example application code, not package exports. The npm package provides Runtime and Workers. Copy the required examples and their relative imports into your application. The examples' `shared.ts` is not a generic routing framework.

## Calling from an application

Install the desired `@codesoul-co/ditto` version, copy `examples/control-flow/routing/` and `examples/_shared/tools/` while preserving relative paths, and supply your own `ditto.yaml` and environment. Place this `app.ts` at the application root:

```ts
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { runRisk } from "./examples/control-flow/routing/risk.ts";
import { createPickupTool, type PickupRecord } from "./examples/_shared/tools/pickup-ledger.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const ledger = new Map<string, PickupRecord>();
const tools = [createPickupTool(ledger)];
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools, output: {
    async deliver(input) {
      console.log(input.message.content);
      return { deliveryId: input.deliveryId, status: "accepted" };
    },
  } })],
});
try {
  const result = await runRisk(runtime, {
    id: "request-731", model: config.model,
    text: "Pickup code PICKUP-731; quantity 3.", risk: 30,
    verify: value => value.code === "PICKUP-731" && value.quantity === 3,
  });
  console.log(result.content.status, result.toolCalls);
} finally { await runtime.close(); }
```

Run `node --env-file=.env app.ts` with Node.js 24+. TypeScript consumers use NodeNext resolution without paths aliases into repository source. Register `record_pickup` only when needed. An explicit Sandbox policy replaces the configured policy; spread `config.sandbox` when adding tool permissions to retain the configured network allowlist.

## Function contracts

All inputs contain `id` and `model`; all except file routing also contain nonempty `text`. Functions accept `Pick<DittoRuntime, "run">` and neither create nor close the caller's Runtime.

| Function | Additional input | Result behavior |
| --- | --- | --- |
| `runStateRouting` | `task: extract \| count`, `state: ready \| blocked` | Blocked state delivers a notification with no samples; other routes call one model |
| `runConditional` | None | One decision and one selected-branch model call; unknown decisions throw |
| `runBranchMerge` | Text containing owner and deadline | Two independent model nodes and one dependent OUTPUT node; invalid calendar dates fail |
| `runFileTask` | `file: { path, name, mediaType }` | Select and invoke an actual parser TOOL before inference/delivery; additionally returns parsed |
| `runFileType` | `file: ParsedFile` | A format-specific graph for applications that already have parsed content |
| `runRisk` | `risk: number`, `verify(value)` | Trusted policy controls execution; actual toolCalls returned; pending routes execute no tool |
| `runConfidence` | `evidence: string`, `assess(value, attempt)` | One initial model call and at most one correction; insufficient final score yields pending_human |

Common output is `{ content, samples, receipt }`. Invalid model output throws. INTERACTION tool failures use their own status rather than a `NodeResult` wrapper. Delivery must be accepted. Exceptions do not roll back external side effects.

A join defined with `.node("merged", "INTERACTION.OUTPUT", ["owner", "deadline"], bind)` waits for both dependencies. `runtime.run(..., { concurrency })` and Worker capacity govern independent-node concurrency. A business failure object is ordinary Graph data, so bind validates both model results before constructing delivery content.

See the [example guide](../../examples/control-flow/routing/README.md) for thresholds, parser boundaries, tool registration and real-model/npm-tarball checks. Durable human tasks, approval authorization and third-party file parsers are application integrations, not implicit routing behavior.

## Original files and task delivery

[File ingestion configuration](../../examples/_shared/tools/file-ingestion/README.md) provides Poppler, CSV/openpyxl, Tesseract and faster-whisper adapters, locked Python dependencies and separate application environment variables. These are ordinary INTERACTION tools, adding no Core nodes or third-party Core dependencies.

```ts
import { runFileTask } from "./examples/control-flow/routing/file-type.ts";

// Register createFileTools(config), createInferWorker() and an application OutputSink first.
const result = await runFileTask(runtime, {
  id: "document-731", model,
  file: { path: "/app/uploads/pickup.pdf", name: "pickup.pdf", mediaType: "application/pdf" },
});
console.log(result.parsed, result.receipt.artifacts);
```

Adapters return name/mediaType, parsed content, sourceSha256 and engine. Mismatched names/MIME, invalid content and tool failures stop before inference. Invalid model output prevents successful delivery.

The application-side [PickupTaskStore](../../examples/_shared/tools/pickup-task-store.ts) supports local task experiments:

| Method / property | Purpose |
| --- | --- |
| `new PickupTaskStore(directory)` | Open tasks.sqlite under an existing directory and initialize task/business/review tables |
| `create(id, kind, risk?)` | Register a unique task with trusted application risk policy |
| `addReference(value)` / `verify(value)` | Store business references and verify extracted records |
| `tool` / `output` | Durable registration tool and file OutputSink for createInteractionWorker |
| `task(id)` / `pickup(id)` | Read persisted task state and actual business records |
| `await review(id, decision, actor)` | Record an application approve/reject decision bound to the pending payload |
| `authorized(id, value)` | Check approval for the exact payload; reject changed parameters |
| `await fail(id, code)` | Persist a failure state and failure artifact |
| `close()` | Close the application-owned SQLite connection; Runtime.close does not close it |

After approval, call `resumeRisk(runtime, { id, value, route, authorize })`. The trusted application callback must return exactly true. The example binds store.authorized and the tool independently checks persisted policy. Resumption executes the approved payload without asking a model to alter it. Pending, approved and rejected are not completed tasks.

`npm run check:examples:routing:tasks:package` checks installed-package execution with original files, actual tools, HTTP inference, SQLite writes and file delivery. An automated acceptance reviewer supplies approve/reject decisions; this tests the review interface rather than claiming real human participation. See the [task experiments](../../examples/control-flow/routing/README.md#task-level-end-to-end-experiments) for cases and artifacts.
