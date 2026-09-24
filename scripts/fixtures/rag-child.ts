import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { RagAdapters } from "../../examples/_shared/tools/rag/adapters.ts";
import { request } from "../../examples/_shared/tools/rag/domain.ts";
import { openAgentStorage } from "../../examples/_shared/tools/storage/workers.ts";
import { runRag } from "../../examples/patterns/rag-qa/index.ts";
const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    phase: { type: "string" },
    provider: { type: "string" },
  },
});
const directory = values.directory!,
  config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider!,
  model = config.providers[provider]!.model!;
const r = request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  ),
  adapters = new RagAdapters(directory, r),
  storage = await openAgentStorage(directory, config),
  spans: string[] = [];
function observed(d: WorkerDefinition): WorkerDefinition {
  return {
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const value = await w.execute(node, input, context);
          if (
            node === "MEMORY.WRITE" &&
            values.phase?.endsWith("-crash") &&
            JSON.stringify(input).includes(
              `:${values.phase.replace("-crash", "")}"`,
            )
          ) {
            await writeFile(
              join(directory, `child-${values.phase}.json`),
              JSON.stringify({
                spans,
                modelCalls: spans.filter((s) => s === "INFER.REASONING.SAMPLE")
                  .length,
              }),
            );
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
  sandbox: { ...config.sandbox, tools: adapters.tools.map((t) => t.name) },
  workers: [
    ...storage.workers,
    createInferWorker(),
    createRetrievalWorker({ providers: adapters.providers }),
    createInteractionWorker({ tools: adapters.tools }),
  ].map(observed),
});
try {
  await runRag(runtime, { request: r, model: { provider, model } });
  await writeFile(
    join(directory, `child-${values.phase}.json`),
    JSON.stringify({
      spans,
      modelCalls: spans.filter((s) => s === "INFER.REASONING.SAMPLE").length,
    }),
  );
} finally {
  await runtime.close();
  await storage.close();
  adapters.close();
}
