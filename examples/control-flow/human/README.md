# 2.6 Human intervention

[简体中文](README.zh-CN.md) · [Category index](../README.md) · [Public API usage](../../../docs/worker-api/human.md)

These examples generate a release notice, present a durable review request, accept a human decision or edit, and resume through public Graph, Context, inference and interaction APIs. SQLite stores tasks, immutable versions, review decisions, pending effects and events. `INTERACTION.OUTPUT` delivers the full proposal to a file inbox.

## Workflows

| Workflow | Entry / export | Task outcome |
| --- | --- | --- |
| Approval before execution | [approval.ts](approval.ts) / `runApproval` | Activate a local release configuration after approval of the payload and target state |
| Intermediate confirmation | [intermediate.ts](intermediate.ts) / `runIntermediate` | Confirm a draft, then use a second model call to create a calendar record and write `.ics` |
| Continue after human editing | [edit-and-continue.ts](edit-and-continue.ts) / `runEditContinue` | Version the replacement, request fresh confirmation, then continue using its date, title and content |
| Review before publication | [review-publish.ts](review-publish.ts) / `runReviewPublish` | Publish the exact reviewed version as JSON and Markdown |
| Escalate to a human | [escalation.ts](escalation.ts) / `runEscalation` | Deliver conflicting sources, available draft, Context and events; record the human assignee |

Effects are real local files in the application directory. The reference application does not deploy a cloud service, publish a public website or submit to an external calendar. [human-review-store.ts](../../_shared/tools/human-review-store.ts) is an application adapter, separate from Ditto Core. Integrations own authentication, authorization, idempotency and atomic target-state checks.

## Run

Use Node.js 24+, configure a model Provider in `ditto.yaml` and `.env`, then run from the repository root:

```sh
npm run build
npm run example:human:approval
npm run example:human:intermediate
npm run example:human:edit
npm run example:human:publish
npm run example:human:escalation
```

Each command creates an independent directory and prints `{ directory, result }`. The first four workflows return `awaiting-review`; the escalation fixture contains conflicting dates and returns `escalated`. Read `inbox/<request-id>.md` for the full proposal, version, digest and operation scope. Add `--provider <configured-provider>` to choose another configured provider.

### Approve, reject and reopen

Use `directory`, `result.request.id` and `result.request.token` from the first response:

```sh
npm run example:human:approval -- --directory /path/to/task \
  --request <request-id> --token <token> \
  --decision approve --actor example-operator --note "Reviewed release and target"

npm run example:human:approval -- --directory /path/to/task
```

Reopening a completed task does not repeat its effect. Use `--decision reject` for a pending request to enter `rejected` without executing the effect. A request accepts one decision.

| Command | Example actor | Purpose |
| --- | --- | --- |
| `example:human:approval` | `example-operator` | `activate` |
| `example:human:intermediate` | `example-editor` | `intermediate` |
| `example:human:edit` | `example-editor` | `edit` |
| `example:human:publish` | `example-publisher` | `publish` |
| `example:human:escalation` | `example-triager` | `handoff`, assignment only |

`--actor` demonstrates an identity supplied by a trusted application controller; it is not authentication for untrusted callers. The application controls the policy in `application.json`. A token binds the reviewed content and operation; it is not an authentication secret.

### Edit, then confirm the replacement

Save a complete copy of `result.artifact.draft` to a JSON file. Preserve `releaseId`; change `date`, `title` or `body`:

```json
{
  "releaseId": "REL-copy-from-task",
  "date": "2027-01-15",
  "title": "Human revised release title",
  "body": "Human revised release instructions."
}
```

```sh
npm run example:human:edit -- --directory /path/to/task \
  --request <original-request-id> --token <original-token> \
  --edit /path/to/replacement.json --actor example-editor --note "Correct date and content"

npm run example:human:edit -- --directory /path/to/task \
  --request <new-request-id> --token <new-token> \
  --decision approve --actor example-editor
```

Editing creates an immutable version, supersedes the previous review, and presents a new request. Use the new request and token for approval. Publication drafts may also be edited after approval but before effect execution; this invalidates that approval. Editing is forbidden once the effect is `executing`. If an edit happens during downstream inference, the old result cannot be applied.

### Publish or claim a handoff

Publication uses `example:human:publish`, `--decision approve` and `--actor example-publisher`, with the same directory/request/token arguments. It writes the reviewed body without post-review rewriting.

```sh
npm run example:human:escalation -- --directory /path/to/task \
  --request <request-id> --token <token> \
  --claim --actor example-triager --note "Assigned to investigate conflicting dates"
```

Assignment sets `request.status` to `assigned` and records `job.assignee`. The job remains `escalated` until the application's human resolution process handles it. A handoff cannot be approved as an execution request.

## Persistence and recovery

```text
<task-directory>/
  application.json           # CLI mode and reviewer policy
  task.source.json           # Input facts
  task.deployment.json       # Local activation target
  reviews.sqlite             # Tasks, versions, requests, effects and events
  inbox/<request-id>.json     # Immutable review snapshot
  inbox/<request-id>.md       # Full readable review
  results/task.json          # Latest task response
  private/task.json          # Confirmed or edited delivery
  private/task.ics            # Calendar artifact
  published/task.json        # Reviewed version and content
  published/task.md          # Publication artifact
```

Only the relevant workflow outputs are created. SQLite is authoritative. Waiting for a human returns normally; close the Runtime and reopen the same directory in another process to resume. Output acceptance means delivery, not approval.

The effect tool independently checks approval, purpose, version and digest, then persists the pending effect before writing files. Retries reuse its approved snapshot. Identical files are reusable; conflicting immutable files are rejected. Target drift blocks activation and retains `executing` for application reconciliation. Cancellation or failure does not roll back files already written. This adapter assumes an application-controlled local directory and does not replace external transactions or conditional writes.

## Verification

```sh
npm run check
npm run check:examples:human:tasks
npm run check:examples:human:tasks:package
```

The task suite covers 18 scenarios: all five workflows, rejection, wrong roles, stale tokens, invalidated approvals, delivery failure recovery, process termination and restart, edits across processes, edits during inference, idempotent reentry, target drift, cancellation and source changes. It uses real HTTP model providers and scripted human decisions through the application controller. Assertions inspect SQLite, review inboxes, activation state, publication content and calendar files; reports include inference traces.

The package suite builds and packs Core, installs the tarball outside the repository, checks strict TypeScript without path aliases and silent module imports, then runs the task suite. Reports are `.examples-human-tasks-live-results.json` and `.examples-human-package-live-results.json`; artifacts are under `.examples-human-tasks/`. Offline regressions additionally cover failed, malformed and truncated model results and pending-effect recovery.
