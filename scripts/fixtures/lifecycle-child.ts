/** Separate process for persisted triggers and an actual file-event producer. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { LifecycleStore } from "../../examples/_shared/tools/lifecycle-store.ts";
import { emitEvent } from "../../examples/control-flow/lifecycle/fixtures.ts";
import { runScheduled } from "../../examples/control-flow/lifecycle/scheduled.ts";
import { runEventTriggered } from "../../examples/control-flow/lifecycle/event-triggered.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
if (!values.directory || !values.phase) throw new Error("directory and phase required");
const directory = values.directory, phase = values.phase, store = new LifecycleStore(directory);
if (phase === "produce-event") {
  try { await delay(100); const job = store.job("task"); await emitEvent(directory, { id: "child-event", type: "release.ready", taskId: job.id, releaseId: job.releaseId, revision: job.expectedRevision }); await writeFile(join(directory, `child-${phase}.json`), JSON.stringify({ pid: process.pid, modelCalls: 0 })); } finally { store.close(); }
} else {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
  if (!provider || !config.providers[provider]) throw new Error("Configure provider");
  const model = config.providers[provider].model ?? config.model?.model; if (!model) throw new Error("Configure model");
  const spans: Record<string, unknown>[] = [];
  function observed(definition: WorkerDefinition): WorkerDefinition { return { ...definition, instantiate() { const worker = definition.instantiate(); return {
    async execute(node, input, context) { const span: Record<string, unknown> = { node, ...context.execution, start: Date.now() }; spans.push(span); try { const result = await worker.execute(node, input, context); if (result && typeof result === "object" && "output" in result) span.output = result.output; return result; } finally { span.end = Date.now(); } }, async dispose() { await worker.dispose?.(); },
  }; } }; }
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(t => t.name) }, workers: [observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools }))] });
  try {
    const run = store.job("task").trigger.kind === "time" ? runScheduled : runEventTriggered;
    const result = await run(runtime, { id: "task", model: { provider, model } }, { waitMs: phase === "waiting-crash" ? 0 : 60_000 });
    await writeFile(join(directory, `child-${phase}.json`), JSON.stringify({ pid: process.pid, result, modelCalls: spans.filter(x => x.node === "INFER.REASONING.SAMPLE").length, spans }, null, 2));
    if (phase === "waiting-crash") process.kill(process.pid, "SIGKILL");
  } finally { await runtime.close(); store.close(); }
}
