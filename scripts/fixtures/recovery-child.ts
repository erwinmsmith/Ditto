/** A separate application process; crash modes deliberately skip cleanup after durable checkpoints. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { RecoveryStore } from "../../examples/_shared/tools/recovery-store.ts";
import { runCheckpoint } from "../../examples/control-flow/recovery/checkpoint-resume.ts";
import { runPause, resumePaused } from "../../examples/control-flow/recovery/pause-resume.ts";
import { runSession } from "../../examples/control-flow/recovery/session-resume.ts";
import { runSideEffectCheck } from "../../examples/control-flow/recovery/side-effect-check.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, url: { type: "string" }, mode: { type: "string" }, provider: { type: "string" } } });
if (!values.directory || !values.url || !values.mode) throw new Error("directory, url and mode required");
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configured provider required");
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined);
if (!modelName) throw new Error("Model required");
const store = new RecoveryStore(values.directory, values.url);
const spans: Record<string, unknown>[] = [];
function observed(definition: WorkerDefinition): WorkerDefinition {
  return { ...definition, instantiate() {
    const worker = definition.instantiate();
    return { async execute(node, input, context) {
      const span: Record<string, unknown> = { node, ...context.execution, start: performance.now() }; spans.push(span);
      try {
        const result = await worker.execute(node, input, context);
        if (result && typeof result === "object" && "output" in result && result.output && typeof result.output === "object" && "usage" in result.output) span.usage = result.output.usage;
        return result;
      } finally { span.end = performance.now(); }
    }, async dispose() { await worker.dispose?.(); } };
  } };
}
const runtime = createDitto({ config, sandbox: { ...config.sandbox, network: [...config.sandbox.network ?? [], values.url], tools: store.tools.map(tool => tool.name) }, workers: [
  observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools })),
] });
try {
  const input = { id: "task", model: { provider, model: modelName } };
  let result: unknown;
  if (values.mode === "reserve-crash") result = await runCheckpoint(runtime, input, { stopAfter: "reserved" });
  else if (values.mode === "pause-crash") result = await runPause(runtime, input);
  else if (values.mode === "lost-crash") result = await runSideEffectCheck(runtime, input);
  else if (values.mode === "resume") result = await runCheckpoint(runtime, input);
  else if (values.mode === "approved-resume") result = await resumePaused(runtime, input);
  else if (values.mode === "session") result = await runSession(runtime, { ...input, question: "Which order and stage did we leave off at?" });
  else throw new Error("Unknown child mode");
  await writeFile(join(values.directory, `child-${values.mode}.json`), JSON.stringify({ pid: process.pid, result, modelCalls: spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length, spans }, null, 2));
  if (values.mode.endsWith("-crash")) process.kill(process.pid, "SIGKILL");
} finally { await runtime.close(); store.close(); }
