import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { openValidationTools } from "../../examples/_shared/tools/validation/tools.ts";
import { resumeFixture } from "../../examples/_shared/tools/validation/fixtures.ts";
import { sandbox, model } from "../../examples/capabilities/validation/cli.ts";
import { runValidation } from "../../examples/capabilities/validation/shared.ts";
const { values } = parseArgs({
    options: { directory: { type: "string" }, phase: { type: "string" } },
  }),
  directory = values.directory!,
  phase = values.phase!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env),
  r = await resumeFixture(directory),
  storage = await openAgentStorage(directory, config),
  business = openValidationTools(directory, r),
  spans: string[] = [];
const save = () =>
  writeFile(
    join(directory, `child-${phase}.json`),
    JSON.stringify({
      spans,
      modelCalls: spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
    }),
  );
function observed(d: WorkerDefinition): WorkerDefinition {
  return {
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const result = await w.execute(node, input, context),
            text = JSON.stringify(input);
          const crash =
            phase === "effect-crash"
              ? node === "INTERACTION.ACT.TOOL" &&
                text.includes('"name":"validation_commit"')
              : phase.endsWith("crash") &&
                node === "MEMORY.WRITE" &&
                text.includes(
                  phase === "report-crash"
                    ? ":report:"
                    : `:${phase.split("-")[0]}"`,
                );
          if (crash) {
            await save();
            process.kill(process.pid, "SIGKILL");
          }
          return result;
        },
        async dispose() {
          await w.dispose?.();
        },
      };
    },
  };
}
const runtime = createDitto({
  config,
  sandbox: sandbox(config, r),
  workers: [
    ...storage.workers,
    createInferWorker(),
    createInteractionWorker({ tools: business.tools }),
  ].map(observed),
});
try {
  await runValidation(runtime, { request: r, model: model(config) });
  await save();
} finally {
  await runtime.close();
  business.close();
  await storage.close();
}
