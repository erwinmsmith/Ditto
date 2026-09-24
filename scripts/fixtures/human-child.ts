/** Independent application process used to verify durable human gates across SIGKILL. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { HumanReviewStore } from "../../examples/_shared/tools/human-review-store.ts";
import { reviewers } from "../../examples/control-flow/human/fixtures.ts";
import { runApproval } from "../../examples/control-flow/human/approval.ts";
import { runIntermediate } from "../../examples/control-flow/human/intermediate.ts";
import { runEditContinue } from "../../examples/control-flow/human/edit-and-continue.ts";
import { runReviewPublish } from "../../examples/control-flow/human/review-publish.ts";
import { runEscalation } from "../../examples/control-flow/human/escalation.ts";
const { values } = parseArgs({ options: { directory: { type: "string" }, phase: { type: "string" }, provider: { type: "string" } } });
if (!values.directory || !values.phase) throw new Error("directory and phase required");
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configured provider required");
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined);
if (!modelName) throw new Error("Model required");
const store = new HumanReviewStore(values.directory, reviewers), spans: Record<string, unknown>[] = [];
function observed(definition: WorkerDefinition): WorkerDefinition {
  return { ...definition, instantiate() { const worker = definition.instantiate(); return {
    async execute(node, input, context) {
      const span: Record<string, unknown> = { node, ...context.execution, start: performance.now() }; spans.push(span);
      try {
        const value = await worker.execute(node, input, context);
        if (value && typeof value === "object" && "output" in value && value.output && typeof value.output === "object" && "usage" in value.output) span.usage = value.output.usage;
        return value;
      } finally { span.end = performance.now(); }
    }, async dispose() { await worker.dispose?.(); },
  }; } };
}
const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) }, workers: [
  observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools, output: store.output })),
] });
try {
  const run = { approval: runApproval, intermediate: runIntermediate, edit: runEditContinue, publish: runReviewPublish, escalation: runEscalation }[store.job("task").mode];
  const result = await run(runtime, { id: "task", model: { provider, model: modelName } });
  await writeFile(join(values.directory, `child-${values.phase}.json`), JSON.stringify({ pid: process.pid, result, modelCalls: spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length, spans }, null, 2));
  if (values.phase.endsWith("crash")) process.kill(process.pid, "SIGKILL");
} finally { await runtime.close(); store.close(); }
