import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { mediaTools } from "../../examples/_shared/tools/multimodal/tools.ts";
import { request } from "../../examples/_shared/tools/multimodal/domain.ts";
import {
  sandbox,
  mediaConfig,
  models,
} from "../../examples/capabilities/multimodal/cli.ts";
import { runMultimodal } from "../../examples/capabilities/multimodal/shared.ts";
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    phase: { type: "string" },
    provider: { type: "string" },
  },
});
const directory = values.directory!,
  phase = values.phase!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env);
const r = request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  ),
  storage = await openAgentStorage(directory, config),
  spans: string[] = [];
const save = () =>
  writeFile(
    join(directory, `child-${phase}.json`),
    JSON.stringify({
      spans,
      images: 0,
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
          const value = await w.execute(node, input, context);
          const crash =
            phase === "publish-effect-crash"
              ? node === "INTERACTION.ACT.TOOL" &&
                JSON.stringify(input).includes('"name":"multimodal_publish"')
              : phase.endsWith("crash") &&
                node === "MEMORY.WRITE" &&
                JSON.stringify(input).includes(`:${phase.split("-")[0]}"`);
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
  sandbox: sandbox(config),
  workers: [
    ...storage.workers,
    createInferWorker(),
    createInteractionWorker({ tools: mediaTools(directory, r, mediaConfig()) }),
  ].map(observed),
});
try {
  await runMultimodal(runtime, { request: r, ...models(config) });
  await save();
} finally {
  await runtime.close();
  await storage.close();
}
