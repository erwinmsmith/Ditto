import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { request } from "../../examples/_shared/tools/long-running/domain.ts";
import { runLongTask } from "../../examples/patterns/long-running/index.ts";
import { observedLongTask } from "./long-running-runtime.ts";
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    phase: { type: "string" },
    provider: { type: "string" },
  },
});
const directory = values.directory!,
  phase = values.phase!,
  provider = values.provider!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env),
  model = config.providers[provider]!.model ?? config.model!.model!;
const r = request(
  JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
);
const spans: string[] = [];
const save = () =>
  writeFile(
    join(directory, `child-${phase}.json`),
    JSON.stringify({
      spans,
      modelCalls: spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
    }),
  );
const observed = (d: WorkerDefinition): WorkerDefinition => ({
  ...d,
  instantiate() {
    const w = d.instantiate();
    return {
      async execute(node, input, context) {
        spans.push(node);
        const result = await w.execute(node, input, context);
        const payload = input as {
          memories?: {
            content?: {
              value?: { cursor?: number; usage?: { modelCalls?: number } };
            };
          }[];
        };
        const state = payload.memories?.[0]?.content?.value;
        if (
          (phase === "commit-crash" &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"long_commit"')) ||
          (phase === "sample-crash" &&
            node === "MEMORY.WRITE" &&
            JSON.stringify(input).includes(':sample-0-1"')) ||
          (phase === "checkpoint-crash" &&
            node === "MEMORY.UPDATE" &&
            state?.cursor === 2) ||
          (phase === "budget-crash" &&
            node === "MEMORY.UPDATE" &&
            state?.cursor === 0 &&
            state.usage?.modelCalls === 1) ||
          (phase === "report-crash" &&
            node === "MEMORY.WRITE" &&
            JSON.stringify(input).includes(':report"'))
        ) {
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
});
const app = await observedLongTask(directory, r, config, observed);
try {
  await runLongTask(
    app.runtime,
    { request: r, model: { provider, model } },
    phase === "pause" ? { pauseAfterBatches: 1 } : {},
  );
  await save();
} finally {
  await app.close();
}
