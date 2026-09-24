# Multiple candidates: generation, evaluation and selection

One main Loop generates a batch of distinct product-copy candidates, evaluates each independently, then selects a winner or combines approved fields and evaluates the combination again. Graphs contain public Worker nodes; candidate contracts, business checks and artifacts belong to the application. No new Core interface or source-tree import is required.

## Runnable consumer

Copy `examples/patterns/candidate-selection`, `examples/_shared/tools/candidates`, `examples/_shared/tools/storage`, `examples/_shared/tools/evidence.ts` and `examples/_shared/tools/execution/files.ts` into a consumer project. Install the Core tarball and the Redis dependency declared in `storage/dependencies/package.json`. Use Node 24, configured `ditto.yaml`, environment model credentials and real Redis (`DITTO_WORKER_CONTEXT_REDIS_URL`). Run this file at the consumer root. Use a persistent directory and omit outer cleanup to retain artifacts.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/candidates/adapters.ts";
import { openCandidates } from "./examples/patterns/candidate-selection/cli.ts";
import { runCandidates } from "./examples/patterns/candidate-selection/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_CANDIDATES_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-candidates-example-"));
try {
  const request = await createDemo(directory, { mode: "fuse" });
  const app = await openCandidates(directory, request, config);
  try {
    const result = await runCandidates(app.runtime, {
      request,
      model: { provider, model },
      // Optional: evaluationModel: { provider: "another-configured-provider", model: "..." }
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

For your own inputs, use application `createTask(directory, input, catalog)`. `input` is `Omit<Request,"sourceDigest">`; the helper validates and fingerprints the catalog and writes the immutable request, catalog and local policy. `catalog` is `{product,cta,facts:[{id,text}]}`. Identity, limits, permission and fallback policy must come from a trusted controller. `createDemo` supplies a fixture catalog for Orbit with offline editing, Markdown export and a shared workspace in the team edition. It does not call or advertise a real commercial service.

## API and stage contracts

| Stage | Public node/API | Contract |
| --- | --- | --- |
| Load / resume | `MEMORY.GET`, `CONTEXT.LOAD`, `INTERACTION.ACT.TOOL` | Immutable request, catalog hash and persisted model budget |
| Generate batch | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | Two to four individual calls with benefit, workflow, reassurance and concise angles |
| Filter | `candidates_save` tool and domain checks | Exact CTA, supported fact IDs, verbatim fact phrases and character limits; normalized duplicate elimination |
| Evaluate | Context → Infer, `candidates_grade` | One isolated evaluation per structurally valid unique candidate; version-bound scores and issues |
| Select | Pure Loop decision over saved grades | Highest eligible weighted score, then stable hash tie-break |
| Combine | Context → Infer, `candidates_save` | Choose approved parent field IDs; controller copies fields without invented content |
| Re-evaluate combination | Context → Infer, `candidates_grade` | A fresh evaluation and full hard checks for the new result |
| Publish | `candidates_publish` | Revalidate ranking, artifact hashes, source and lineage; write copy and audit report |

`runCandidates(runtime,input,options)` makes one `runtime.loop` call to `runCandidatesLoop`. Generator helpers yield `graphStep` invocations under the same 1024-Graph budget. Graphs contain no nested Graph/Loop nodes; generators perform no filesystem, database, network or Worker execution. Generation is sequential so later candidates can avoid repeating earlier text; evaluation uses separate contexts without the other candidates' scores. This is distinct candidate generation, not parallel execution. `Input.evaluationModel` can choose another configured model; by default evaluation uses the same model in separate calls, not independent external verification. These entrypoints are example application exports, not extra Core package exports.

## Acceptance and ranking

A `Candidate` has `{headline,body,cta,factIds}`. Headline length is at most 40 Unicode code points and body length at most 160. The body quotes at least two catalog fact phrases verbatim, IDs are distinct and supported, and CTA equals the approved catalog text. A generated malformed candidate, hard failure or invalid assessment is retained as an excluded slot while other candidates continue. A normalized duplicate (NFKC, lower case, whitespace/punctuation removal) is excluded without another assessment. Different generation angles and this textual filter encourage diversity; they do not prove semantic novelty.

`Assessment` is bound to the exact candidate hash and contains verdict, integer scores from 0 to 5, a public rationale and issues. Score = `2 × clarity + 2 × audience fit + credibility` (maximum 25). Only candidates passing hard checks, receiving a model pass with no issues and meeting `minScore` are eligible. Invalid IDs, out-of-range scores or contradictory verdicts are excluded. Scores are rubric judgments, not probabilities or evidence of market performance. Hard checks establish supported quoted phrases and structural compliance; model evaluation assesses readability and any additional prose claims, which are not formally proven true.

At least one qualified candidate permits selection; the report records excluded slots and never claims that all candidates passed. No qualified result or insufficient catalog facts produces `needs-human`, with no accepted copy. Ties use candidate-hash order, and replay reuses the saved assessments. The original chosen candidate is copied unchanged.

## Fusion and fallback

Fusion uses the top two qualified candidates. The model chooses `{headlineFrom,bodyFrom,ctaFrom,reason}` using their exact IDs. Headline and body must come from different parents. The controller copies those fields verbatim and takes `factIds` from the body parent. A combination identical to an existing candidate is rejected. This deliberate field-composition contract demonstrates grounded fusion; it is not free-form synthesis of new factual claims.

The combined result is a new candidate and must pass fresh deterministic checks and a new model evaluation. A parent's score never substitutes for the combined result's grade. If fusion is invalid, rejected or has fewer than two qualified parents, `allowFallback: true` permits the best already-qualified original candidate, explicitly marked `applied: fallback`. With fallback disabled, the task returns `needs-human`. Budget/deadline exhaustion returns `partial` without an accepted copy and does not silently trigger fallback.

## Persistence and artifacts

- Context uses real Redis; Memory uses persistent SQLite. Only an absent Context cache is rebuilt. Redis/Memory faults propagate without an in-memory fallback. Request or source changes require a new task. Business inputs and outputs are actual catalog and artifact files, not another Memory backend.
- Model-call reservations and the original start time are saved before calls. Limits include generation, evaluation, fusion and re-evaluation and survive restart. A crash may consume a reservation without a saved result. The deadline includes paused time and prevents new model calls; AbortSignal cancels active runtime work.
- `Options.stopAfter` supports `candidate`, `assessment`, `fusion` and `report`. Resume with the original directory/request and omit the checkpoint option. One active runner owns a task directory. Artifact writes are immutable; repeated publication does not regenerate candidates or scores.
- `candidates/<hash>.json` and `grades/<hash>.json` preserve content and evaluation evidence. `output/report.json` and `output/report.md` retain slot outcomes, ranking, fallback reasons and fusion lineage. Only completion writes `output/copy.json` and `output/copy.md`. Publication writes local files; it does not post marketing copy or send messages externally.
- Every tool checks the request fingerprint and current permission file. The local policy file demonstrates a trusted integration boundary, not an authentication provider. Protect storage and supply authenticated identity in deployments. Other Memory backends use public `MemoryStore`; SQLite acceptance does not establish PostgreSQL/MySQL coverage.

## Adaptation and verification

For creative generation, replace candidate schema and rubric. For solution design, add feasibility/cost verifiers. For reasoning search, add domain checks or actual test execution tools and treat scores as selection signals rather than proofs. Keep integrations in application tools outside Core.

`npm run check:examples:candidates:package -- --provider deepseek` installs the actual tarball outside the repository, checks strict types without path aliases, blocks private Core imports, checks silent imports, executes complete real-model tasks and runs the consumer above. Cases cover selection, true field fusion, invalid candidates/assessments, duplicate removal, tie-breaking, rejection/thresholds, fusion rejection and fallback prohibition, budgets, Redis expiry/unavailability, Memory faults, changed inputs/permissions, tampered artifacts, cancellation, process kills and publication retry. Explicit model-output fault injections are labeled in results; normal selection and fusion use actual model outputs.
