# Public data and code workflows

[简体中文](data-code-workflows.zh-CN.md) · [Twelve examples](../../examples/capabilities/data-and-code/README.md)

These workflows reuse exported Runtime, Graph, Context, Memory, Infer and Interaction APIs. Models propose SQL/programs/edits; application tools actually execute and validate them. No database-, renderer- or language-specific Core node is needed.

| Stage | Public nodes | Responsibility |
| --- | --- | --- |
| Restore | `MEMORY.GET` | Request fingerprints and durable checkpoints |
| Material | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | CSV, actual schema and source snapshots |
| Context | `MEMORY.WRITE`, `CONTEXT.LOAD` | Database persistence and Redis session reconstruction |
| Plan | `INFER.REASONING.SAMPLE` | Structured tool selection, SQL, function body or module |
| Execute | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | Actual SQL, code, search, chart or test execution |
| Explain | `CONTEXT.LOAD`, `INFER.REASONING.SAMPLE` | Conclusions from actual results and an exact evidence catalog |
| Deliver | `MEMORY.WRITE`, `INTERACTION.ACT.TOOL` | Evidence validation, artifact writing and readback |

## Consumer integration

Install `@codesoul-co/ditto` plus the Redis SDK, and copy the application capability/tools directories including shared execution/storage utilities. Examples and third-party execution environments are not bundled in Core. See [tool setup](../../examples/_shared/tools/data-and-code/README.md).

Save this as `data-code-app.ts` at your consumer root:

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { dataCodeTools } from "./examples/_shared/tools/data-and-code/tools.ts";
import { resumeFixture } from "./examples/_shared/tools/data-and-code/fixtures.ts";
import { sandbox, model, toolConfig } from "./examples/capabilities/data-and-code/cli.ts";
import { runDataCode } from "./examples/capabilities/data-and-code/shared.ts";

const directory = resolve(process.argv[2]!);
const request = await resumeFixture(directory);
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const storage = await openAgentStorage(directory, config);
try {
  const runtime = createDitto({
    config,
    sandbox: sandbox(config, request),
    workers: [
      ...storage.workers,
      createInferWorker(),
      createInteractionWorker({
        tools: dataCodeTools(directory, request, toolConfig()),
      }),
    ],
  });
  try {
    const result = await runDataCode(runtime, { request, model: model(config) });
    console.log(JSON.stringify(result));
  } finally {
    await runtime.close();
  }
} finally {
  await storage.close();
}
```

```sh
node --env-file=.env data-code-app.ts /absolute/task-directory
```

`runDataCode(runtime,input,options)` is an application composition function, not a Core export. Entry-point `run` functions also enforce the mode. `input.model` uses public `ModelConfig`; options accept `signal` and `stopAfter: "material" | "plan" | "outcome" | "interpretation"`.

Requests contain id, tenant, mode, instruction and `{path,sha256}[]` sources. The example inventory is either sales CSV/business SQLite or a module/protected-tests/specification directory. Replace data within that contract, or adapt tools/validators for another schema, code interface or business policy. Candidate code is delivered into the task output, not applied to an existing user repository.

## Tools and evidence

Plans contain `{tool,arguments}`. A mode-specific allowlist, argument checks and pinned source hash precede execution. JSON proposals still run through public `INTERACTION.ACT.TOOL`, the registry and Sandbox; no Worker executor is called directly from a model callback.

Outcomes contain tool/result/evidence/files. Verified results enter Memory. Application receipts in `effects/` support recovery after a tool succeeds but before Memory stores its outcome. Receipts and business databases do not replace Agent Memory.

Interpretations contain summary/insights/issues/limitations. Insights cite short scalar values enumerated from the actual result, checked using JSON Pointers and exact values. Large logs remain in TAP artifacts rather than being regenerated as quotations. Code issues require original path, 1-based line, exact line text, severity, reasoning and a suggested fix.

These checks establish source/value agreement, not universal semantic correctness. See the [example contracts](../../examples/capabilities/data-and-code/README.md) for test/business scope.

## Persistence and failure

Redis Context is rebuilt from database Memory after expiry. The default Memory adapter uses file SQLite; consumers may inject another public MemoryStore. Connection errors do not silently fall back to local memory. Request fingerprints reject changed goals/source versions under the same ID.

Truncated model output, invalid evidence, denied SQL, code timeout, failed protected tests and changed artifact hashes fail the current run. No candidate is approved by bypassing tests or changing controller-owned expectations. Use a new task request to revise a plan; intact checkpoints can resume without repeating completed inference. Run one controller per task. Local file delivery is not authorization to publish or merge externally.

## Package gate

```sh
npm run check:examples:data-code:tasks:package
```

The gate installs an actual tarball outside the repository, copies application tools, checks strict types without aliases and guards private imports, then runs real task experiments. The consumer contains no Core source tree. Python and containers are application dependencies; all Workers are scheduled through public Runtime APIs.
