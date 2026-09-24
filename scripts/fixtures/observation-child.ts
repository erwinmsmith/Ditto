import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { ResultTools } from "../../examples/_shared/tools/observation/tools.ts";
import { request } from "../../examples/_shared/tools/observation/domain.ts";
import { sandbox } from "../../examples/capabilities/observation/cli.ts";
import { runObservation } from "../../examples/capabilities/observation/shared.ts";
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    phase: { type: "string" },
    provider: { type: "string" },
  },
});
const directory = values.directory!,
  phase = values.phase!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider ?? config.model!.provider!,
  model = config.providers[provider]!.model ?? config.model!.model!;
const r = request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  ),
  storage = await openAgentStorage(directory, config),
  adapters = new ResultTools(directory, r),
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
          const value = await w.execute(node, input, context);
          const crash =
            phase === "retry-effect-crash"
              ? node === "INTERACTION.ACT.TOOL" &&
                JSON.stringify(input).includes('"name":"result_retry"')
              : phase === "state-effect-crash"
                ? node === "INTERACTION.ACT.TOOL" &&
                  JSON.stringify(input).includes('"name":"result_commit"')
                : phase.endsWith("crash") &&
                  node === "MEMORY.WRITE" &&
                  JSON.stringify(input).includes(`:${phase.split("-")[0]}-0"`);
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
    createInteractionWorker({ tools: adapters.tools }),
  ].map(observed),
});
try {
  await runObservation(runtime, { request: r, model: { provider, model } });
  await save();
} finally {
  await runtime.close();
  await storage.close();
  adapters.close();
}
