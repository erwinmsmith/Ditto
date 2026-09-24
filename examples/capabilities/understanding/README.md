# 3.1 Request understanding and interaction

[简体中文](README.zh-CN.md) · [Capabilities](../README.md) · [Public API usage](../../../docs/worker-api/understanding.md)

These examples turn natural-language requests into validated goals, constraints and interaction states for a complete release-report task. A model interprets the conversation; application rules validate parameters, ask questions or present options, then produce actual Markdown/JSON drafts. Redis stores working Context. `MEMORY.GET / WRITE` persist conversation archives in a separate `memory.sqlite` database. `understanding.sqlite` stores business state, input journals, questions, selections, and report versions.

## Six capabilities

| Capability | Entry / export | Behavior |
| --- | --- | --- |
| Goal understanding | [goal.ts](goal.ts) / `runGoal` | Identify the release-report outcome, project and audience; complete the task |
| Constraint extraction | [extract-parameters.ts](extract-parameters.ts) / `runConstraints` | Extract and check time, format, budget, permissions and scope |
| Clarification | [clarification.ts](clarification.ts) / `runClarification` | Deliver questions for missing information and continue after a reply |
| Multi-turn conversation | [conversation.ts](conversation.ts) / `runConversation` | Apply corrections while preserving unchanged constraints; answer status requests |
| Option selection | [choices.ts](choices.ts) / `runChoices` | Present affordable plans and execute the selected plan |
| Intent recognition | [intent.ts](intent.ts) / `runIntent` | Distinguish report creation, status, cancellation and unclear requests |

All use public Graph, Context, Memory, inference and interaction nodes. The application adapter [understanding-store.ts](../../_shared/tools/understanding-store.ts) uses Node.js standard libraries and SQLite, independently of Core internals.

## Run

Use Node.js 24+ and configure the model Provider and `DITTO_WORKER_CONTEXT_REDIS_URL` in root configuration. Start Redis and install the application SDK first (see [storage setup](../../_shared/tools/storage/README.md)):

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
```

Run the six entries:

```sh
npm run example:understanding:goal
npm run example:understanding:constraints
npm run example:understanding:clarification
npm run example:understanding:conversation
npm run example:understanding:choices
npm run example:understanding:intent
```

Each command creates a directory and prints `{ directory, result }`. Clarification starts with missing constraints and returns `needs_clarification`; choices returns `awaiting_choice`; the remaining defaults create a report and return `completed`.

Use `--message "request"` for a custom initial request, and `--provider <configured-provider>` to choose a provider. The fixture's project name is `result.source.topic`. Reuse the directory to submit later messages or choices without recreating inputs.

### Reply to a clarification

Read `result.view.text`, `result.view.missing` or `inbox/session-r1.md`, then use the returned directory, revision and token:

```sh
npm run example:understanding:clarification -- --directory /path/to/session \
  --revision 1 --token <question-token> --message-id user-2 \
  --message "Deadline 2027-12-15T09:00:00.000Z, Markdown, budget 25 yuan, local draft only; do not publish. Include changes and metrics."
```

The reply joins the earlier goal in Context. No report is generated while required information is missing. A question must be delivered before accepting a reply. Stale revisions, incorrect tokens and conflicting reuse of a message ID are rejected; retrying the same message ID and text does not append another turn.

### Continue a conversation

```sh
npm run example:understanding:conversation -- --directory /path/to/session \
  --revision 1 --message-id user-2 \
  --message "Change the format to JSON and include only changes. Keep the other requirements."

npm run example:understanding:conversation -- --directory /path/to/session \
  --revision 2 --message-id user-3 \
  --message "What is the report status? Do not create another report."
```

The correction preserves project, audience, deadline, budget and draft permissions, producing a new version while retaining the earlier file. A status request reports the existing artifact. Cancellation stops the current request and preserves prior artifacts; a later explicit message can start another turn.

### Choose an option

```sh
npm run example:understanding:choices -- --directory /path/to/session \
  --revision 1 --token <choice-token> --choice detailed
```

Plans are `brief` (500 cents) and `detailed` (1000 cents). Unaffordable plans are neither offered nor selectable. Detailed output adds a reading guide without changing the requested data scope. Selection creates the next revision and executes the parsed request without another model call. Old choices cannot authorize a new revision.

Costs are fixed reference-business values; no payment occurs. `--message` and `--choice` are mutually exclusive. Tokens bind delivered questions and versions, not user identities. The calling application authenticates users and enforces session access.

## Parameters and execution

| Parameter | Supported values |
| --- | --- |
| Intent | `create_report`, `status`, `cancel`, `unknown` |
| Project | Explicit project name, matched against the actual source at execution |
| Audience | `engineering` / `customers` |
| Deadline | Explicit date, time and timezone, normalized to UTC ISO |
| Format | `markdown` / `json` |
| Budget | Integer cents; 100 cents per yuan |
| Requested permission | `draft_only` / `publish` |
| Scope | `changes`, `metrics`, or both |

Non-null parameters and known intents include evidence with a user-turn ID and supporting quote. The adapter verifies that each quote exists in a user turn; semantic interpretation still depends on model results and business checks. Missing or ambiguous values are null and require clarification. Options mentioned by the assistant do not become user constraints automatically.

The application permits local drafts only. Publication requests return `POLICY_DENIED`; interpreted requests do not grant authority. Expired deadlines, insufficient budgets, unknown projects and changed source data block report registration. Reports include only requested sections; responses retain normalized constraints and source evidence.

## Persistence

```text
<session-directory>/
  application.json           # CLI example type
  source.json                # Actual report facts
  understanding.sqlite       # Business state, input journals, artifacts and events
  memory.sqlite              # MEMORY Worker conversation archive database
  inbox/session-r1.json       # Full interaction response
  inbox/session-r1.md         # Readable question/options/result
  artifacts/session-r1.md    # Markdown report
  artifacts/session-r2.json  # Later JSON report
  results/session.json       # Latest exported session snapshot
```

Per-turn stages are received, analyzing, needs_clarification, awaiting_choice, ready, completed, answered, blocked, cancelled and failed. Business SQLite stores transactional state and the acknowledged archive revision, not a complete Context object. Context is scoped by session namespace and revision in Redis; Memory archives interactions by revision. Expired Context is rebuilt from `MEMORY.GET`. Connection failures do not fall back to local snapshots. Reopen the directory after closing Runtime to continue. Reentry does not repeat inference or registration for an already processed revision.

A new message during inference invalidates the older output. After delivery, `MEMORY.WRITE` archives the interaction before acknowledging `memoryRevision`. Write failures surface to the caller; reentry archives without regenerating the report. Stable keys make retries idempotent when a process stops after Memory commits but before acknowledgement. Reports are registered in SQLite before file export; retry failed delivery without repeating interpretation. Waiting replies and choices survive process restarts. A process killed while analyzing requires application reconciliation/recovery; execution ownership is not automatically stolen.

## Verification

```sh
npm run check
npm run check:examples:understanding:tasks
npm run check:examples:understanding:tasks:package
```

Twenty-five task scenarios cover all six capabilities, Chinese time/money normalization, missing timezone, invalid selections/replies, budget and permission rejection, source changes, delivery failure, new turns during inference and replies/selections after forced process termination. They also cover Redis expiry and Memory restoration, Redis/Memory failures, archiving after report completion, and interruption after Memory commits. Models use real HTTP providers, real Redis, and persistent SQLite, while user actions are scripted by the test controller.

Package acceptance installs an npm tarball outside the repository, checks strict types without path aliases and silent imports of all six entries, then guards module loading against repository source or unexported Core paths. Reports are `.examples-understanding-tasks-live-results.json` and `.examples-understanding-package-live-results.json`; artifacts are under `.examples-understanding-tasks/`.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
