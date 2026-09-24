import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { request } from "../../examples/_shared/tools/human-loop/adapters.ts";
import { runHumanLoop } from "../../examples/patterns/human-in-the-loop/index.ts";
import { observedHumanLoop } from "./human-loop-runtime.ts";
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
            JSON.stringify(input).includes('"human_apply"')) ||
          (phase === "draft-crash" &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"human_save_draft"')) ||
          (phase === "review-crash" && node === "INTERACTION.OUTPUT") ||
          (phase === "generate-crash" &&
            node === "MEMORY.WRITE" &&
            JSON.stringify(input).includes(':generate"'))
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
const app = await observedHumanLoop(directory, r, config, observed);
try {
  await runHumanLoop(app.runtime, { request: r, model: { provider, model } });
  await save();
} finally {
  await app.close();
}
