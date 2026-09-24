# 2.4 Loops and dynamic adjustment

[简体中文](README.zh-CN.md) · [Control flow](../README.md) · [All examples](../../README.md)

Build a release brief with public Ditto Graph, Loop, INFER and INTERACTION APIs. Actual files supply authoritative facts; tools retain evidence, revise a draft and check every required field. [brief-files.ts](../../_shared/tools/brief-files.ts) is an application adapter using only Node.js standard libraries.

## Six workflows

| File / entry point | Behavior |
| --- | --- |
| [bounded-loop.ts](bounded-loop.ts) / `runBounded` | Repeat one revision Graph, repair one unresolved field and check after each saved revision |
| [adaptive-loop.ts](adaptive-loop.ts) / `runAdaptive` | Validate a model-proposed action and select the next native planning, search or repair Graph; replan after failed lookups |
| [improvement.ts](improvement.ts) / `runImprovement` | Inspect and fix an existing draft, retaining correct fields and every saved revision |
| [retrieval.ts](retrieval.ts) / `runRetrieval` | Query missing evidence using untried sources, then compose and verify the final brief |
| [goal-check.ts](goal-check.ts) / `runGoalCheck` | Inspect before execution and after each revision; return immediately for a valid existing document |
| [stop-conditions.ts](stop-conditions.ts) / `runStopConditions` | Stop for completion, blocked evidence, round limit or Sample-call budget, retaining partial work |

Each module contains its Loop orchestration. [shared.ts](shared.ts) supplies Graphs and validators; [cli.ts](cli.ts) owns configuration and lifecycle; [fixtures.ts](fixtures.ts) creates randomized task files. Imports perform no work.

## Run

Requires Node.js 24+ and npm 11+. Run `npm ci` and configure Provider credentials/model/network permissions in `.env` using the [configuration guide](../../../docs/worker-api/configuration.md). Commands explicitly load ditto.yaml and .env and use real HTTP models.

```bash
npm run example:iteration:bounded
npm run example:iteration:adaptive
npm run example:iteration:improvement
npm run example:iteration:retrieval
npm run example:iteration:goal
npm run example:iteration:stop -- --model-call-budget 1
```

Defaults create a brief with release code, owner and deadline. Adaptive execution starts with a nonexistent source and must choose its backup after actual failure. Improvement starts with incorrect values. Goal checking starts with one remaining defect. The stop CLI defaults to one Sample call and retains an incomplete brief; a budget of three completes the default task.

For your own task:

```bash
npm run example:iteration:adaptive -- --input /absolute/path/release-input --max-rounds 24 --model-call-budget 12
```

The input directory contains spec.json and `<sourceId>.json`:

```json
{
  "required": ["code", "owner"],
  "catalog": [
    { "id": "release", "fields": ["code"] },
    { "id": "team", "fields": ["owner"] }
  ],
  "initialDraft": { "owner": "previous-team" },
  "initialEvidence": []
}
```

release.json contains `{"facts":{"code":"REL-731"}}`; team.json contains `{"facts":{"owner":"platform-team"}}`. These are application-trusted authoritative records; acceptance means exact structured fact consistency. Sources are tried in catalog order, at most once per field/source pair. Limits: 16 fields, 32 sources, one MiB per source, lowercase letter-led alphanumeric/hyphen IDs and nonempty single-line values.

Revision-only workflows (bounded, improvement, goal, stop) require evidence covering every field in initialEvidence. Adaptive execution and retrieval can begin without evidence.

## Contracts and termination

All entry points accept `(runtime, input, options?)`. The caller owns Runtime and registers workers. Input is `{ model, maxRounds?, modelCallBudget? }`; both limits default to 24 and accept integers from 0 to 100. Options are `{ signal?: AbortSignal }`, forwarded to every Graph/Loop.

`BriefReport` contains `{ status, reason, rounds, modelCalls, snapshot }`. The snapshot includes draft, evidence/source hashes, attempts, revision, missing evidence and unresolved fields.

Termination precedence is goal → blocked → round-limit → budget. Only goal means completed; other reasons return stopped. An already valid document or empty goal succeeds even with zero budget/rounds. Complete evidence without a finished document remains incomplete.

Each Loop Graph execution counts as one round. Adaptive planning/search/repair are separate rounds; retrieval's final composition also counts. Budget units are INFER.REASONING.SAMPLE nodes, reserved before execution: planning and revision cost one each, a file-only search costs zero. An already planned zero-cost search can run at a depleted model budget. This is not a token/currency limit or an accounting of Provider-internal retries.

Native maxIterations remains a hard guard: a definition whose done never returns true throws `Loop iteration limit reached`. Application done handles normal stopped outcomes. Cancellation, tool errors, invalid plans and failed/truncated model responses reject without a normal completion report; saved revisions remain. Completion is determined by file/evidence checks, regardless of model self-assessment.

## Artifacts

CLI runs retain `.examples-iteration-tasks/cli-*/input/` and `output/`:

```text
output/
├── spec.json
├── state.json
├── revisions/0.json         # Original draft
├── revisions/1.json         # Each saved revision
├── rounds/1.json            # Checked snapshot, next action, cumulative calls
├── brief.md                 # Completed or partial brief
└── result.json              # Verified outcome and stop reason
```

Start each task in a fresh output directory; reuse is rejected. State JSON uses temporary writes plus rename, and round records reject overwrites. Checks reread evidence files and fail when hashes/values change. A new adapter can verify artifacts after Runtime shutdown.

## End-to-end task experiments

```bash
npm run check
npm run check:examples:iteration:tasks
npm run check:examples:iteration:tasks:package
npm run check:examples:iteration:tasks:package -- --provider deepseek
```

Seventeen cases cover all six workflows, fallback replanning, existing/empty goals, zero and nonzero budgets/round limits, blocked/missing sources, incomplete composition after evidence collection, adaptive budget reservations, the native hard guard and pre-cancellation. Random files flow through actual tools and real models into checked revisions and final documents. Tests inspect plans, rounds, source hashes and artifact values, then reopen files after Runtime shutdown.

Package acceptance installs an npm tarball outside the repository, checks strict public types with no paths aliases/package source, verifies silent imports and executes the same tasks without model/tool doubles. Offline regressions additionally cover incorrect model values, invalid plans, failed/truncated inference, active cancellation and changed evidence.

Artifacts remain in `.examples-iteration-tasks/run-*/`. Reports `.examples-iteration-tasks-live-results.json` and `.examples-iteration-package-live-results.json` include provider/model, actual Worker intervals, Graph/node/run IDs, model usage and task results. Failed assertions exit nonzero.

See [API usage](../../../docs/worker-api/iteration.md) for integration and native Loop semantics.
