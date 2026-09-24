# Human intervention: public API usage

[简体中文](human.zh-CN.md) · [Runtime](runtime.md) · [Five workflows and commands](../../examples/control-flow/human/README.md)

Applications compose public `graph`, `runtime.run`, `CONTEXT.LOAD`, `INFER.REASONING.SAMPLE`, `INTERACTION.ACT.TOOL` and `INTERACTION.OUTPUT` APIs. Application tools persist task state, review policy, artifact versions and effects. No business approval API is added to Core, and delivery receipts do not grant approval.

## Integration and complete call

Use Node.js 24+. In an application with `@codesoul-co/ditto` installed, copy `examples/control-flow/human/` and `examples/_shared/tools/human-review-store.ts`, preserving relative paths. Prepare `ditto.yaml` and `.env`. These are application sources, not Core package exports. The adapter uses only Node.js standard libraries, including `node:sqlite`.

This example creates a pending task and defines a continuation handler for an authenticated human decision. Never register `onHumanDecision` as a model tool. Derive `actor` from a verified session, not an untrusted username in a request.

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { HumanReviewStore } from "./examples/_shared/tools/human-review-store.ts";
import { createFixture, reviewers } from "./examples/control-flow/human/fixtures.ts";
import { runApproval } from "./examples/control-flow/human/approval.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const input = { id: "task", model: config.model };
const directory = await mkdtemp(join(tmpdir(), "ditto-human-"));
await createFixture(directory, "approval");

function open() {
  const store = new HumanReviewStore(directory, reviewers);
  const runtime = createDitto({
    config,
    sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
    workers: [
      createContextWorker(),
      createInferWorker(),
      createInteractionWorker({ tools: store.tools, output: store.output }),
    ],
  });
  return { store, runtime };
}

const first = open();
try {
  await first.store.create(input.id, "approval");
  const pending = await runApproval(first.runtime, input);
  console.log({ directory, request: pending.request, stage: pending.job.stage });
} finally {
  await first.runtime.close();
  first.store.close();
}

// Invoke only from the application's authenticated human-decision handler.
export async function onHumanDecision(decision: {
  requestId: string;
  expectedToken: string;
  choice: "approve" | "reject";
  actor: string;
}) {
  const next = open();
  try {
    next.store.decide(decision);
    return await runApproval(next.runtime, input);
  } finally {
    await next.runtime.close();
    next.store.close();
  }
}
```

A new process should load the original directory from application configuration, reconstruct the Runtime and Store, and call the same workflow. Do not call `create` again or recreate inputs. The CLI demonstrates this process boundary. Replace the fixture policy with application-owned reviewer permissions.

## Workflow functions

Exports are `runApproval`, `runIntermediate`, `runEditContinue`, `runReviewPublish` and `runEscalation`. Files and commands are listed in the [example guide](../../examples/control-flow/human/README.md). All use this signature:

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { id: string; model: ModelConfig },
 options?: { signal?: AbortSignal }) => Promise<HumanResult>
```

`HumanResult` contains `job`, `artifact: Version | null` and `request: ReviewRequest | null`. The job mode must match the function. Waiting, rejection, handoff and completion return durable states normally. Tool failures, validation errors and cancellation throw. `runEscalation` converts failed or unusable model results into handoffs; cancellation and other errors propagate.

| Stage | Meaning and next action |
| --- | --- |
| `queued` | Inputs saved; load facts and create Context |
| `drafted` | Version saved; create and deliver the review |
| `awaiting-review` | Wait for a decision or permitted edit; reentry delivers the same snapshot |
| `approved` | Next call executes the reviewed version; intermediate/edit workflows first run downstream inference |
| `rejected` | Stop this execution and preserve the rejection |
| `executing` | Pending effect persisted; reentry reconciles and resumes that snapshot |
| `completed` | Effect and result saved; reentry returns the existing result |
| `escalated` | Handoff to a human; assignment does not automatically resume execution |

Public Context is saved before inference, retaining evidence even when inference fails. Review snapshots include the full proposal, version, artifact and source digests, operation type and target. Activation also binds the target's initial digest. The output sink marks the request delivered only after writing the exact snapshot. Its `accepted` receipt still requires a separate human decision.

## Application review controller

`HumanReviewStore(directory, reviewers)` opens SQLite in an existing directory. `ReviewerPolicy` is `Readonly<Record<string, readonly Purpose[]>>`; purposes are `activate`, `intermediate`, `edit`, `publish` and `handoff`.

| Method | Contract |
| --- | --- |
| `create(id, mode)` | Read `<id>.source.json` and `<id>.deployment.json`; return `Promise<HumanJob>`; new tasks only |
| `job(id)` | Read the durable task; reject unknown IDs or unsupported schema |
| `version(id, version?)` | Read a specific or latest immutable version and verify its digest |
| `request(requestId)` | Read a review request and verify its snapshot token |
| `decide({ requestId, expectedToken, choice, actor, note? })` | Approve or reject a delivered, pending, current-version request with the required role; return the updated job |
| `edit({ requestId, expectedToken, replacement, actor, note })` | For edit/publication tasks awaiting review or approved before execution; create a full version, supersede the old review and return a drafted job |
| `claim({ requestId, expectedToken, actor, note })` | Assign a pending handoff and record the actor and note |
| `close()` | Close SQLite after Runtime work finishes |

`decide`, `edit` and `claim` are trusted controller methods, absent from `store.tools`. The token is a SHA-256 digest of the review snapshot, binding content and operation scope. It is not an authentication secret. Authenticate and authorize the human before accepting decisions.

After editing, invoke the workflow to deliver the new request, approve its new request/token, then invoke the workflow again. Editing never auto-approves. Old tokens cannot authorize replacements. A replacement is a full `{ releaseId, date, title, body }` object and cannot change `releaseId`. Downstream calendar inference receives only the approved version; the effect tool rechecks version, digest and output fields to reject stale results after concurrent edits.

IDs contain 1–64 letters, digits, underscores or hyphens. Input accepts 1–8 unique source IDs. Dates must be valid `YYYY-MM-DD`; titles allow 200 characters, bodies 4000, and the input change sentence 1000. Edit and assignment notes must be nonempty and at most 1000 characters.

## Tools and delivery boundaries

| Application tool | Responsibility |
| --- | --- |
| `human_read` | Read job, artifact and request |
| `human_source` | Read actual source files and verify their digest |
| `human_save_context` | Persist public Context and source digest before inference |
| `human_save_draft` | Check source facts; save the first generated version and Context |
| `human_request_review` | Persist review/handoff requests without granting execution rights |
| `human_apply` | Check approval and exact version, persist a pending effect, then write actual files |
| `human_report` | Persist and return the complete task result |

Inject `store.output` as an `OutputSink` with `createInteractionWorker({ tools: store.tools, output: store.output })`. Tools implement `RegisteredTool` and are explicitly allowed in the sandbox. Preserve configured network rules for model access. Tool metadata does not replace authorization within `human_apply`.

Publication writes the body from the reviewed snapshot. Calendar delivery verifies that model-generated `{ releaseId, date, title }` exactly matches the approved artifact. A persisted pending effect resumes its original version after failure or process termination without regenerating content. Identical files may be reused; conflicting files are not overwritten. Target drift, partial file writes and cancellation require application reconciliation, not an assumption of rollback. The local file adapter assumes application ownership of its directory. External systems must implement conditional writes or transactions and idempotency; a file digest check is not a distributed transaction.

Handoffs include the task, sources, public Context, events and any available draft. Reasons include `CONFLICTING_DATES`, `MODEL_FAILED`, `MODEL_INVALID` and `HUMAN_REVIEW_REQUIRED`. Assignment records the actor and note while preserving `escalated`. Conflicting sources also route ordinary approval workflows to handoff rather than executing on the first date.

## Task acceptance

The [task suite](../../scripts/check-examples-human-tasks.ts) verifies 18 real scenarios, including actual inbox failures, restart after `SIGKILL`, edits across processes and during inference, rejected/stale reviews, exact-version publication and target drift. A test controller represents human decisions; model calls use real providers. Failed model outputs are additionally covered by offline regressions. The [package suite](../../scripts/check-examples-human-package.ts) installs an `npm pack` tarball outside the repository, typechecks without source aliases, and runs the complete task suite. See the [example guide](../../examples/control-flow/human/README.md) for commands, directories and reports.
