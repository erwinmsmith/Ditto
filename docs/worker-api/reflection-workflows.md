# Reflection / Self-Refine workflows

One main Loop composes generation, verification, model review, revision and rechecking through public Worker nodes. The example produces a monthly business report from a real CSV, with exact source quotes, calculated net revenue, limitations and proposed follow-up actions. An existing flawed draft can enter at the review stage. The application defines the rubric and artifact tools; Core provides Graph, Loop, Infer, Interaction, Context and Memory. This composition needs no private API or new Core interface.

## Runnable consumer

Copy `examples/patterns/reflection`, `examples/_shared/tools/reflection`, `examples/_shared/tools/storage`, `examples/_shared/tools/evidence.ts` and `examples/_shared/tools/execution/files.ts` into a consumer project. Install the Core tarball and Redis dependency declared in `storage/dependencies/package.json`. Use Node 24, `ditto.yaml`, model credentials in the environment and a real Redis server (`DITTO_WORKER_CONTEXT_REDIS_URL`). Run the following from the consumer root. Use a persistent directory and omit outer cleanup to retain artifacts.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/reflection/adapters.ts";
import { openReflection } from "./examples/patterns/reflection/cli.ts";
import { runReflection } from "./examples/patterns/reflection/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_REFLECTION_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-reflection-example-"));
try {
  const request = await createDemo(directory, "flawed-draft");
  const app = await openReflection(directory, request, config);
  try {
    const result = await runReflection(app.runtime, {
      request,
      model: { provider, model },
      // Optional: reviewModel: { provider: "another-configured-provider", model: "..." }
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## Contracts and composition

| Stage | Public node/API | Contract |
| --- | --- | --- |
| Load / resume | `MEMORY.GET`, `CONTEXT.LOAD`, `INTERACTION.ACT.TOOL` | Immutable request, source and optional initial-draft fingerprints |
| Generate / revise | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | Complete structured draft; revision receives previous draft and all feedback |
| Verify | `INTERACTION.ACT.TOOL` (`reflection_check`) | Recompute net revenue and growth; check exact row quotes and required fields |
| Reflect | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | Version-bound review with `pass`, `revise` or `needs-human`, and actionable issues |
| Save | `MEMORY.WRITE` / `MEMORY.UPDATE`, artifact tools | Durable budgets, samples, drafts, reviews and check proofs |
| Publish | `reflection_publish` | Only a draft passing both gates becomes `output/analysis.json` |

`runReflection(runtime,input,options)` makes one `runtime.loop` call using `runReflectionLoop`. Reusable generator helpers `yield* graphStep` into the same Loop and share a 1024-Graph budget. Graphs contain only Worker nodes; plans perform no tool, filesystem, network or database I/O. `Input.model` generates and revises; optional `Input.reviewModel` selects another configured model for review. The default uses the same model in separate calls and contexts, not independent external verification. These entrypoints are application exports, not additional Core package exports.

`Request` fixes tenant, principal, goal, CSV digest, optional seed digest, maximum draft versions, actual model-call budget and elapsed deadline. `Draft` contains title, net-revenue metrics, interpretation, limitations, actions with responsible roles and exact source citations. July and August are the fixed periods in this business fixture. `Review` contains the exact `draftId`, verdict and `{field,message}` issues. A pass must have no issues; revise/human verdicts must explain concrete issues. Stale IDs and malformed output stop explicitly. The model may assess semantics and quality but cannot override deterministic failures.

The CSV fixture has gross/refund cents of 120000/6000 and 150000/9000. Tools calculate net revenue as 114000 and 141000, with growth of 23.68%. `flawed-draft` supplies a real initial JSON file with incorrect metrics, an unsupported campaign explanation and absent citations, limitations and actions. The critic identifies problems, the writer revises, and both checks run again. This fixture is an existing user draft, not a claim that a model generated those errors. `generate` starts with actual model generation and may pass its first review; a successful result need not be changed unnecessarily. `missing-data` stops for additional input before model generation because a two-period comparison cannot be computed.

## Completion, recovery and artifacts

- Completion requires a structurally valid review bound to the exact draft hash, `verdict: pass`, no reviewer issues and no deterministic issues. Publication rereads drafts, source fingerprints, review files and check proofs. Draft/check tampering and output conflicts fail visibly.
- Writer and critic prompts treat source/draft content as data. A report must avoid unsupported causal explanations and predictions. Deterministic checks prove the arithmetic, quoted rows and required structure; the semantic review is a model judgment and is not a proof that every prose claim is true. Human review may be appropriate for consequential use.
- Context uses real Redis; Memory uses file-backed SQLite. Only cache absence is rebuilt from Memory. Redis/Memory failures propagate without fallback. Source or request changes require a new task. This example has no separate business database: business inputs are real CSV files and outputs are real immutable artifacts.
- Before each model call, persist a reservation. Counts and the initial start time survive process restart and refinement. A crash may consume a call without saving its response. `maxRounds` counts draft versions (including a supplied seed); `maxModelCalls` counts generation, review and revision attempts. Tool calls are under the shared Graph budget.
- Stop on completion, human review, missing data, round/call/deadline limits, invalid output or an identical revised draft (`no-progress`). Partial reports retain draft IDs and completed review history but do not publish an accepted analysis. The deadline includes paused time and prevents admission of new model calls; use an AbortSignal to cancel active runtime work.
- `stopAfter: "draft" | "review" | "report"` returns a checkpoint. Resume with the same directory/request and omit `stopAfter`. One active runner owns a task directory. Replaying a completed report uses saved data with no further model calls; immutable publication is retryable.
- `drafts/<hash>.json`, `checks/<hash>.json`, `reviews/<version>.json`, `output/report.json` and `output/report.md` retain the audit trail. Only completion writes `output/analysis.json`. The Markdown report includes interpretation, limitations, proposed actions and exact source rows; no messages are sent and proposed actions are not executed.

The trusted controller creates `request.json` and `policy.json`; every tool checks identity and policy. Local policy files demonstrate the integration boundary, not an authentication service. Protect the task directory and inject authenticated identities in a deployment. Other Memory databases may use public `MemoryStore`; SQLite acceptance does not establish PostgreSQL/MySQL compatibility.

## Adaptation and acceptance

For content generation, replace the draft schema and rubric. For code generation, register an application tool that runs tests in an appropriate sandbox and supplies actual diagnostics to the next revision. For other reports or reasoning tasks, supply domain evidence and verifiers. Keep these tools outside Core; the example does not claim to execute generated code or provide a general mathematical proof checker.

`npm run check:examples:reflection:package -- --provider deepseek` installs the real tarball outside the repository, checks strict types without path aliases, blocks private imports, checks silent imports, runs full tasks and executes the consumer above. Tests cover fresh generation, seeded revision, false reviewer acceptance, unchanged drafts, malformed output, limits, missing data, Redis expiry/unavailability, Memory failure, identity/source changes, artifact tampering, cancellation, process kills and publication retry. Model-output substitutions and cancellations are labeled fault injections; regular generation and seeded revision use real model outputs.
