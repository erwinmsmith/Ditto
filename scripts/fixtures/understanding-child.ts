import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { openUnderstandingStorage } from "../../examples/capabilities/understanding/storage.ts";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { UnderstandingStore } from "../../examples/_shared/tools/understanding-store.ts";
import { runUnderstanding } from "../../examples/capabilities/understanding/shared.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
if (!values.directory || !values.phase) throw new Error("directory and phase required");
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider"); const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure model");
const store = new UnderstandingStore(values.directory), spans: Record<string, unknown>[] = [];
function observed(definition: WorkerDefinition): WorkerDefinition { return { ...definition, instantiate() { const worker = definition.instantiate(); return {
  async execute(node, input, context) { const span: Record<string, unknown> = { node, ...context.execution, start: Date.now() }; spans.push(span); try { const value = await worker.execute(node, input, context); if (node === "INFER.REASONING.SAMPLE") span.result = value;
      if (node === "MEMORY.WRITE" && values.phase === "archive-crash") {
        await writeFile(join(values.directory!, `child-${values.phase}.json`), JSON.stringify({ pid: process.pid, result: store.session("session"), modelCalls: spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length, spans }, null, 2));
        process.kill(process.pid, "SIGKILL");
      }
      return value; } finally { span.end = Date.now(); } }, async dispose() { await worker.dispose?.(); },
}; } }; }
const storage = await openUnderstandingStorage(values.directory, config);
const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(t => t.name) }, workers: [...storage.workers.map(observed), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools, output: store.output }))] });
try {
  const result = await runUnderstanding(runtime, { id: "session", model: { provider, model } }, store.session("session").mode);
  await writeFile(join(values.directory, `child-${values.phase}.json`), JSON.stringify({ pid: process.pid, result, modelCalls: spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length, spans }, null, 2));
  if (values.phase.endsWith("crash")) process.kill(process.pid, "SIGKILL");
} finally { await runtime.close(); await storage.close(); store.close(); }
