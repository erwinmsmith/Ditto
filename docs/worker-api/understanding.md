# Request understanding and interaction with public APIs

[简体中文](understanding.zh-CN.md) · [API index](README.md) · [Six runnable examples](../../examples/capabilities/understanding/README.md)

These examples turn a user's request into a release report task. They cover goals, constraints, clarification, conversation, multiple choices, and intent. Each entry constructs graphs from public nodes and executes them through `DittoRuntime.run()`. Sessions, reports, authorization rules, and file delivery belong to the application adapter; these business types are not additional Core APIs.

## Core APIs and application responsibilities

| Public entry / node | Purpose |
| --- | --- |
| `@ditto/core/runtime`: `createDitto`, `graph`, `loadRuntimeConfigFile` | Register Workers, construct graphs, and run them |
| `@ditto/core/worker/context`: `createContextWorker` | Restore history with `CONTEXT.LOAD`; merge conversation turns with `CONTEXT.UPDATE` |
| `@ditto/core/worker/memory`: `createMemoryWorker`, `MemoryStore` | Read conversation archives with `MEMORY.GET`; archive delivered turns with `MEMORY.WRITE` |
| `@ditto/core/worker/infer`: `createInferWorker`, `ModelConfig` | Interpret goals, parameters, and intent with `INFER.REASONING.SAMPLE` |
| `@ditto/core/worker/interaction`: `createInteractionWorker`, `RegisteredTool`, `OutputSink` | Call application tools with `INTERACTION.ACT.TOOL`; deliver questions, choices, or results with `INTERACTION.OUTPUT` |
| `@ditto/core/contracts`: `Context`, `ExternalResult` | Handle public Context data and check tool outcomes |

The model produces a structured interpretation. The application deterministically renders the report from actual `source.json` data. User messages, model output, and assistant questions remain distinct; parameter evidence must cite user text. The [application adapter](../../examples/_shared/tools/understanding-store.ts) does not import Core source or private Worker executors.

## Initialization and execution

First install the Redis SDK and configure a server using the [storage guide](../../examples/_shared/tools/storage/README.md). `openUnderstandingStorage(directory, config)` creates a Redis Context Worker and a separate file SQLite Memory Worker, returning `workers`, `redis`, and `close()`.

Place this code in an application root. Prepare the directory and source file before injecting tools. The examples' `createFixture()` can also generate runnable data. Relative imports refer to application code: copy the example directories into the consumer after installing the npm package.

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { UnderstandingStore } from "./examples/_shared/tools/understanding-store.ts";
import { runClarification } from "./examples/capabilities/understanding/clarification.ts";
import { openUnderstandingStorage } from "./examples/capabilities/understanding/storage.ts";

const directory = resolve("report-session");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "source.json"), JSON.stringify({
  topic: "ORION", changes: ["Added CSV export."],
  metrics: { testsPassed: 42, fixes: 3 },
}));
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure model.provider and model.model");
const storage = await openUnderstandingStorage(directory, config);
const store = new UnderstandingStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [...storage.workers, createInferWorker(),
    createInteractionWorker({ tools: store.tools, output: store.output })],
});
try {
  await store.create("session", "clarification", "Create a release report for ORION, for engineers.");
  const result = await runClarification(runtime, { id: "session", model: config.model });
  console.log(result.view); // Delivered question, missing fields, revision, and token
} finally {
  await runtime.close();
  await storage.close();
  store.close();
}
```

To resume, reopen the directory and register tools without calling `create()` or overwriting `source.json`. An application controller authenticates the user and checks access to the session before accepting a reply and invoking the same entry:

```ts
store.receive({
  id: "session", messageId: "user-2", expectedRevision: 1,
  replyToken: deliveredQuestion.token,
  text: userReply,
});
const result = await runClarification(runtime, { id: "session", model });
```

`deliveredQuestion`, `userReply`, and `model` come from the delivered response, user input, and application configuration. A model-generated reply must not substitute for the user's decision. `receive()` and `choose()` are trusted controller methods, not model tools.

## Six application entries

Each function has the signature `(runtime: Pick<DittoRuntime, "run">, input: { id: string; model: ModelConfig }, options?: { signal?: AbortSignal }) => Promise<Session>`.

| File / function | Session mode |
| --- | --- |
| `goal.ts` / `runGoal` | `goal` |
| `extract-parameters.ts` / `runConstraints` | `constraints` |
| `clarification.ts` / `runClarification` | `clarification` |
| `conversation.ts` / `runConversation` | `conversation` |
| `choices.ts` / `runChoices` | `choices` |
| `intent.ts` / `runIntent` | `intent` |

The mode must match the invoked entry. All entries perform interpretation, validation, clarification, and delivery. `choices` additionally waits for a selection before execution. The clarification CLI starts with an incomplete request; other CLIs start with complete requests. Programmatic callers supply their own messages.

## Parameters, state, and reply protocol

`Session.analysis` contains `intent`, `topic`, `audience`, `deadline`, `format`, `budgetCents`, `permission`, `scope`, and `evidence`. A goal is represented by `intent=create_report`, project, and audience. Missing parameters are `null`; assistant questions and default options cannot supply them.

- Intent is `create_report`, `status`, `cancel`, or `unknown`. Status and cancellation do not require complete report parameters; unknown intent triggers clarification.
- Deadlines require a date, time, and timezone and normalize to UTC `YYYY-MM-DDTHH:mm:ss.000Z`. Budgets use integer cents from 0 through 1,000,000.
- Format is `markdown` or `json`; audience is `engineering` or `customers`; scope is `changes`, `metrics`, or both.
- Each non-null parameter and known intent carries `{ turnId, quote }` evidence. Validation checks that the quote occurs in an actual user turn. This provides traceability; semantic interpretation still depends on the model and business validation.
- Only local drafts are permitted. A `publish` request is denied; recognizing a permission request does not grant it. Unknown projects, expired deadlines, insufficient budgets, and changed source data also block execution.

`Session.view` contains `kind`, `text`, `missing`, `choices`, `analysis`, `artifact`, `revision`, `token`, and `delivered`. Questions and choices must be successfully delivered through `INTERACTION.OUTPUT` before the application accepts an answer. Tokens bind response content and revision; they are not authentication credentials.

| Application method | Behavior |
| --- | --- |
| `create(id, mode, message)` | Create revision 1 from source data; reject an existing ID |
| `session(id)` | Read authoritative SQLite state |
| `receive({ id, messageId, text, expectedRevision, replyToken? })` | Append a user message and increment revision; require a delivered token while awaiting a reply or choice |
| `choose({ id, expectedRevision, token, choiceId })` | Select an offered option, increment revision, and enter `ready` without another model call |
| `close()` | Close the application database; the Runtime is closed by its owner |

Retrying the same message ID and text returns the current session without appending again. Reusing an ID with different text fails. New messages must match the current revision. IDs contain up to 64 letters, digits, underscores, or hyphens; messages contain up to 8000 characters. Selections cannot be replayed against later revisions.

`brief` costs 500 cents and `detailed` costs 1000; only affordable options are offered. Detailed Markdown includes a reading guide; JSON identifies the chosen option through `style`. These costs only validate the local budget; no payment occurs.

## Graph execution and recovery

The controller first reads the archive referenced by `memoryRevision` through `MEMORY.GET`, then tries `CONTEXT.LOAD({ scope })`. Only a missing or expired cache permits initialization from Memory turns. Other errors surface to the caller and release the inference claim for retry. The interpretation graph runs scoped `CONTEXT.LOAD` → `CONTEXT.UPDATE` → `INFER.REASONING.SAMPLE` → the interpretation validation tool. Sample must succeed, finish with `stop`, and return parseable JSON. Truncation, provider failure, and invalid evidence produce `failed`. Tool `ExternalResult.status` must also indicate success.

The controller continues according to durable state: missing parameters produce questions; choices produce options; `ready` invokes report registration; status and cancellation deliver their respective responses. The presentation graph obtains a view through a tool and delivers it through `INTERACTION.OUTPUT`. After delivery, `CONTEXT.UPDATE` writes the complete interaction to Redis; `MEMORY.WRITE` archives it in `memory.sqlite` before acknowledging `memoryRevision` in business state.

Transactions claim work and validate revisions. A new message arriving during inference prevents the older result from overwriting the new turn. Before registering a report, the tool rechecks the source digest, deadline, permission, and budget. Report version and completed state are committed in one SQLite transaction before immutable files are exported. File delivery failure can be retried without reinterpreting the request. Reentering a delivered turn does not repeat inference or registration.

`Session.namespace` is a persistent UUID. Context scope is `{ sessionId: namespace, turnId: String(revision) }`, and Memory keys are `conversation:<namespace>:<revision>`. Business storage contains input journals, transactional state, and archive pointers, not a complete Context object. A Memory write failure surfaces to the caller while retaining the report. Reentry retries the archive. Identical keys and content return the same record; conflicting content fails, covering interruptions between Memory commit and business acknowledgement.

Processes may close while waiting for a reply or selection and continue from the same directory. If a process stops during `analyzing`, the application must reconcile execution and apply its own recovery policy; this example does not automatically take over a claim. Cancellation does not roll back an already registered report. `Session.modelCalls` counts claimed inference attempts, including attempts cancelled before HTTP starts; experiment reports separately count actual Sample calls.

## Package consumer verification

```sh
npm run check
npm run check:examples:understanding:tasks:package
```

Package verification runs `npm pack`, installs the tarball outside the repository, typechecks application code strictly without `paths`, and checks silent imports for all six entries. Module loading restrictions block repository source and private Core paths. Twenty-five complete task experiments then use real HTTP models and inspect actual Redis values and TTL, the separate Memory database, business SQLite, interaction inboxes, and report files. They cover both waiting boundaries, cache expiry, storage failures, and process termination after Memory commit.

Results are saved to `.examples-understanding-package-live-results.json`, with model information, task inputs, turns, outcomes, and traces. Test controllers simulate user replies and choices; actual application tools generate task artifacts.
