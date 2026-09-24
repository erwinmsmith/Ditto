import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { request } from "../../examples/_shared/tools/multi-agent/domain.ts";
import { runMultiAgent } from "../../examples/patterns/multi-agent/index.ts";
import { observedMultiAgent } from "./multi-agent-runtime.ts";
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
        if (
          (phase === "effect-crash" &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"team_save"')) ||
          (phase === "sample-crash" &&
            node === "MEMORY.WRITE" &&
            JSON.stringify(input).includes(':sample-engineering-1"')) ||
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
const app = await observedMultiAgent(directory, r, config, observed);
try {
  await runMultiAgent(app.runtime, { request: r, model: { provider, model } });
  await save();
} finally {
  await app.close();
}
