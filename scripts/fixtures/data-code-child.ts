import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { dataCodeTools } from "../../examples/_shared/tools/data-and-code/tools.ts";
import { request } from "../../examples/_shared/tools/data-and-code/domain.ts";
import {
  sandbox,
  toolConfig,
  model,
} from "../../examples/capabilities/data-and-code/cli.ts";
import { runDataCode } from "../../examples/capabilities/data-and-code/shared.ts";
const { values } = parseArgs({
    options: { directory: { type: "string" }, phase: { type: "string" } },
  }),
  directory = values.directory!,
  phase = values.phase!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env),
  r = request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  ),
  storage = await openAgentStorage(directory, config),
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
          const value = await w.execute(node, input, context),
            text = JSON.stringify(input),
            crash =
              phase === "publish-effect-crash"
                ? node === "INTERACTION.ACT.TOOL" &&
                  text.includes('"name":"data_code_publish"')
                : phase === "execute-effect-crash"
                  ? node === "INTERACTION.ACT.TOOL" &&
                    text.includes('"name":"data_query"')
                  : phase.endsWith("crash") &&
                    node === "MEMORY.WRITE" &&
                    text.includes(`:${phase.split("-")[0]}"`);
          if (crash) {
            await save();
            process.kill(process.pid, "SIGKILL");
          }
          return value;
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
    createInteractionWorker({
      tools: dataCodeTools(directory, r, toolConfig()),
    }),
  ].map(observed),
});
try {
  await runDataCode(runtime, { request: r, model: model(config) });
  await save();
} finally {
  await runtime.close();
  await storage.close();
}
