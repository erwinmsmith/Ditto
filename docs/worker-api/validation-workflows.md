# Validation, evaluation and safety API composition

The [nine examples](../../examples/capabilities/validation/README.md) compose existing public APIs. Business authorization, rubrics and redaction rules remain application-owned; no additional Core operation is required.

| Stage | Public nodes | Application responsibility |
| --- | --- | --- |
| Input | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | Bound and validate input, verify checksum, redact before returning values |
| Checkpoints | `MEMORY.GET` / `MEMORY.WRITE` | Persist request fingerprint, sanitized material, validated assessment and report |
| Context | `CONTEXT.LOAD` with explicit scope | Real Redis; reconstruct only on `CONTEXT_NOT_FOUND` |
| Evaluation | `INFER.REASONING.SAMPLE` | Fixed rubric, bounded JSON and exact evidence validation |
| Publication | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | Re-read input, recheck current policy and commit the business record atomically |
| Delivery | `MEMORY.WRITE` | Store actual receipt and hashed report file reference |

## Complete integration

Save the following as `validation-example.ts` at the consumer root. Copy `examples/capabilities/validation`, `examples/_shared/tools/validation`, `examples/_shared/tools/storage` and `examples/_shared/tools/execution/files.ts`; install the Core tarball and Redis adapter dependencies. Supply `ditto.yaml` and provider environment variables. The same file runs at the repository root.

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { openValidationTools } from "./examples/_shared/tools/validation/tools.ts";
import { createFixture } from "./examples/_shared/tools/validation/fixtures.ts";
import { model, sandbox } from "./examples/capabilities/validation/cli.ts";
import { run } from "./examples/capabilities/validation/risk.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
await mkdir(".examples-validation-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-validation-tasks/api-"));
const request = await createFixture(directory, "risk");
const storage = await openAgentStorage(directory, config);
try {
  const business = openValidationTools(directory, request);
  try {
    const runtime = createDitto({
      config,
      sandbox: sandbox(config, request),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: business.tools }),
      ],
    });
    try {
      const pending = await run(runtime, { request, model: model(config) });
      if (!("receipt" in pending)) throw new Error("Expected completed review");
      console.log(pending.receipt); // confirmation-required; no publication
      // Only call after the host authenticates an authorized reviewer and
      // receives their explicit approval for this exact assessment and target.
      // await business.approve(pending.assessment, "trusted-reviewer");
      // const published = await run(runtime, { request, model: model(config) });
    } finally {
      await runtime.close();
    }
  } finally {
    business.close();
  }
} finally {
  await storage.close();
}

```

```sh
node --env-file=.env validation-example.ts
```

## Contract

`Request` is `{ id, tenant, mode, sourceHash }`. Identifiers are restricted strings and `sourceHash` is the raw `source.json` SHA-256. The request does not accept free-form instructions, authorization flags, tool names or arbitrary paths. The adapter validates file size, symlinks and checksum. Replace synthetic fixture creation with a trusted ingress in a deployed application.

All entries export `run(runtime, input, options)`; the shared function is `runValidation`. Options accept `signal` and `stopAfter: "material" | "assessment"`.

- Checkpoint result: `{ status: "checkpoint" }`.
- Full `Report`: `taskId`, `mode`, `material`, `assessment`, `receipt`, `file`, `sha256`.
- Findings contain `{ path, kind }`, never original sensitive values. Checks cover explicit requirements, same-metric numeric conflicts and known instruction patterns.
- Assessment has completeness/relevance/clarity scores, one integer 0–4 per dimension, explanations and exact path/quote evidence. A score below 2 blocks publication. Invalid shapes, evidence or sensitive outputs throw before assessment persistence.
- Receipt status is `published`, `denied` or `confirmation-required`; it includes reason codes, `policyRevision`, sanitized `payloadHash` and a non-null `effectId` only for publication.

Reuse of a task ID requires the identical request. Recovery reuses persisted assessment, checks current input and policy, and acknowledges an existing effect without duplicating it. Different decisions create content-addressed report files, preserving history.

## Trusted controller

`openValidationTools(directory, request)` exposes `tools`, `current()`, `setPolicy(policy)`, `approve(assessment, actor)`, `countEffects()` and `close()`. Only `tools` is registered with the Interaction Worker.

`Policy` contains `revision`, `actor`, `tenant`, `role: "publisher" | "reader"`, `targetTenant`, `target`, `affected`, `reversible`, `enabled` and `maxAffected`. Revisions must increase. Unknown fields, invalid counts and unknown reversibility fail closed. The host authenticates identities; the example's restricted `trusted-reviewer` string is a controller identity illustration, not a production authentication mechanism.

Approval binds the request, exact sanitized document, assessment and entire policy. Changing the target or policy invalidates it. Approval cannot bypass a permission, policy, content or quality denial. Neither model text nor a tool's descriptive `requiresApproval` flag creates approval; Core does not automatically open an approval UI.

Graphs fix tool names. `sandbox.tools` allows only `validation_source` and `validation_commit`. Database access uses application clients and enforcement lives inside the adapter. Sandbox is cooperative access control, not arbitrary JavaScript isolation. No general SQL, command, network-send or authorization-management tool is exposed.

## Persistence and safety

Raw source → adapter validation/redaction → Runtime / Context / Memory → model evaluation → transactional gate → sanitized publication and report. The original input remains in the private source file and requires independent access and retention controls. The [documented detection scope](../../examples/capabilities/validation/README.md#scope) is intentionally limited; it is not universal DLP or injection detection.

Redis and SQLite Memory are required, with no process-memory fallback on failure. Business publication uses a separate SQLite database. Denied/pending outcomes deliver a report; infrastructure and integrity failures reject. `signal` is propagated through Runtime. Cancellation cannot undo a committed operation; recovery reconciles its idempotency record. Revoking permissions does not retract an already published record.

`npm run check:examples:validation:tasks:package` verifies a real npm consumer, models, Redis, separate SQLite stores, delivered artifacts and process-kill recovery. Worker wrappers in test fixtures are for observation/fault injection only, not application invocation.

Report checkpoints use stage keys `report:<sha256>` and append with `MEMORY.WRITE`, preserving pending and approved decision history.
