# Validation, evaluation and safety

Nine entry points compose public `@ditto/core` Runtime graphs for source validation, model evaluation, permission checks, publication and report delivery.

| Capability | Entry | Default task |
| --- | --- | --- |
| Result validation | `schema.ts` | Reject a missing title; verify summary, actions and evidence requirements |
| Quality evaluation | `evaluate.ts` | Score completeness, relevance and clarity with exact source quotes; reject unrelated actions |
| Consistency | `consistency.ts` | Locate conflicting values for the same metric and block publication |
| Permissions | `permissions.ts` | Check trusted role and both actor/target tenants; reject a reader |
| Operation risk | `risk.ts` | Require confirmation for irreversible or multi-object operations |
| Business policy | `policy.ts` | Enforce publication enablement and affected-object limits |
| Input safety | `input-safety.ts` | Flag known instruction-injection patterns without granting authority to document text |
| Sensitive data | `sensitive-data.ts` | Return sensitive field locations and categories without original values |
| Redaction | `redaction.ts` | Redact before inference, Context, Memory, reports and business publication |

Every entry runs the complete check chain. Denied and pending tasks deliver reports but create no publication record. `createFixture(directory, mode, "valid")` produces a synthetic valid task for each entry.

## Run

Use Node.js 24+, a real text model configured in `ditto.yaml` / `.env`, Redis and the storage adapter dependencies.

```sh
npm install
npm --prefix examples/_shared/tools/storage/dependencies install
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:validation:schema
npm run example:validation:evaluate
npm run example:validation:consistency
npm run example:validation:permissions
npm run example:validation:risk
npm run example:validation:policy
npm run example:validation:input-safety
npm run example:validation:sensitive-data
npm run example:validation:redaction
```

Imports perform no work. CLI results include the task directory, evidence, decision and report path. `--checkpoint` exits after evaluation; `--directory <task-directory>` resumes. Recovery revalidates the source checksum and current policy. Changed sources require a new task.

Each module exports `run(runtime, { request, model }, options)`, supporting `signal` and `stopAfter: "material" | "assessment"`. See [API usage and approvals](../../../docs/worker-api/validation-workflows.md).

## Storage and enforcement

Redis stores sanitized Context. The Memory Worker persists checkpoints in `memory.sqlite`; missing or expired Context is reconstructed, while storage outages fail without an in-memory fallback. Separate `business.sqlite` tables hold trusted policies, payload-bound approvals and actual publication records.

The commit adapter rechecks policy and inserts the publication in one SQLite write transaction. Approvals bind the exact document, evaluation and policy revision. Approval cannot override a denied permission, policy, requirement or quality threshold. The host controller supplies authenticated identities and operation metadata; none is inferred by the model.

Publication is idempotent. Recovery acknowledges an already committed record without repeating it, including after a subsequent permission revocation. Revoking previously published content requires a separate business operation.

Raw synthetic input remains only in application-owned `source.json` (0600). The adapter sanitizes it before returning anything to Runtime. Deployments must separately protect and expire raw source files.

## Scope

The fixed input schema rejects unknown fields. Redaction covers designated name/address/email/phone/secret fields, text email addresses, mainland China mobile numbers and prefixed `sk-`, `token-`, `secret-` markers. It is not a universal DLP system: unmarked secrets, encoded content, names in prose and other countries' identifiers need additional rules or a dedicated provider.

Input pattern matching is not a complete prompt-injection defense. Tool names, targets and authorization remain controller-owned. Consistency checks cover same-metric numeric claims, not arbitrary factual truth. Model quality scores can be biased; explicit rule failures take precedence and low scores block publication. Sandbox enforces cooperative access, not OS isolation.

## Complete acceptance

```sh
npm run check:examples:validation:tasks:package
```

The gate installs the actual npm tarball outside the repository, checks strict types without path aliases, blocks private imports and verifies nine silent imports. Real models, Redis and SQLite produce actual publication records and report files. Cases cover allow/deny/confirm, trusted approval, stale approval, policy revocation, tenant boundaries, invalid evidence, sensitive model output, expiry, storage outages, cancellation and process-kill recovery. Privacy assertions inspect model/Worker inputs and outputs, Redis, Memory, business SQLite/WAL and report artifacts for synthetic sensitive sentinels.

Ignored reports: `.examples-validation-package-live-results.json`; artifacts: `.examples-validation-tasks/`. SQLite acceptance does not establish PostgreSQL/MySQL acceptance.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
