/** Real-model acceptance checks for the sequence examples. Run explicitly with .env. */
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker, type NodeResult, type SampleOutput, type Usage } from "@ditto/core/worker/infer";
import { createInteractionWorker, type InteractionOutputInput } from "@ditto/core/worker/interaction";
import { pipelineGraph } from "../examples/control-flow/sequence/pipeline.ts";
import { dependenciesGraph } from "../examples/control-flow/sequence/dependencies.ts";
import { runStages } from "../examples/control-flow/sequence/stages.ts";
import { runBatch } from "../examples/control-flow/sequence/batch.ts";

const { values } = parseArgs({ options: {
  provider: { type: "string" },
  report: { type: "string", default: ".examples-sequence-live-results.json" },
} });
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const providers = values.provider?.split(",") ?? (config.model ? [config.model.provider] : []);
assert.ok(providers.length && providers.every(name => name && config.providers[name]), "Select a configured provider with --provider or DITTO_WORKER_INFER_MODEL_PROVIDER");

function completed(result: NodeResult<SampleOutput>): SampleOutput {
  const httpStatus = result.error?.code === "PROVIDER_HTTP_ERROR"
    ? result.error.message.match(/HTTP \d{3}/)?.[0] : undefined;
  assert.equal(result.status, "success", `Model call failed: ${result.error?.code ?? result.status}${httpStatus ? ` (${httpStatus})` : ""}`);
  assert.ok(result.output, "Missing model output");
  assert.equal(result.output.finishReason, "stop", "Model must complete without truncation or actions");
  assert.equal(result.output.message.role, "assistant");
  assert.equal(typeof result.output.message.content, "string");
  return result.output;
}

function answer(result: NodeResult<SampleOutput>): unknown {
  const sample = completed(result);
  return JSON.parse(String(sample.message.content).trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

interface CaseReport {
  provider: string;
  model: string;
  example: string;
  status: "passed" | "failed";
  durationMs: number;
  expected: unknown;
  executionId?: string;
  executionIds?: string[];
  usage?: Usage;
  actual?: unknown;
  modelCalls?: number;
  deliveries?: number;
  error?: string;
}
interface WorkflowResult {
  samples: readonly NodeResult<SampleOutput>[];
  actual: unknown;
  finalContent: unknown;
}
const startedAt = new Date().toISOString();
const results: CaseReport[] = [];
async function save() {
  await writeFile(values.report!, JSON.stringify({
    startedAt, checkedAt: new Date().toISOString(),
    transport: "configured HTTP model providers", providers,
    passed: results.filter(result => result.status === "passed").length,
    failed: results.filter(result => result.status === "failed").length,
    results,
  }, null, 2) + "\n");
}

for (const provider of providers) {
  const modelName = config.providers[provider]!.model
    ?? (config.model?.provider === provider ? config.model.model : undefined);
  assert.ok(modelName, `Missing model for provider ${provider}`);
  const model = { provider, model: modelName };
  const deliveries: InteractionOutputInput[] = [];
  // Only built-in Workers and the configured HTTP providers; no model doubles.
  const runtime = createDitto({ config, workers: [
    createContextWorker({ policy: config.context.policy ?? {} }),
    createInferWorker(),
    createInteractionWorker({ output: { async deliver(input) {
      deliveries.push(input);
      return { deliveryId: input.deliveryId, status: "accepted" };
    } } }),
  ] });

  const runCase = async (example: string, expected: unknown, run: () => Promise<NodeResult<SampleOutput> | WorkflowResult>) => {
    deliveries.length = 0;
    const start = Date.now();
    const report: CaseReport = { provider, model: modelName, example, status: "failed", durationMs: 0, expected };
    console.log(JSON.stringify({ provider, model: modelName, example, event: "started" }));
    try {
      const value = await run();
      const outcome: WorkflowResult = "samples" in value ? value : {
        samples: [value], actual: answer(value), finalContent: completed(value).message.content,
      };
      report.executionIds = outcome.samples.map(sample => sample.executionId);
      if (report.executionIds[0]) report.executionId = report.executionIds[0];
      const usage: Usage = {};
      for (const sample of outcome.samples) {
        const output = completed(sample);
        for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "cachedInputTokens"] as const) {
          if (output.usage?.[key] !== undefined) usage[key] = (usage[key] ?? 0) + output.usage[key];
        }
      }
      if (Object.keys(usage).length) report.usage = usage;
      report.modelCalls = outcome.samples.length;
      report.actual = outcome.actual;
      report.deliveries = deliveries.length;
      assert.deepEqual(report.actual, expected, "Model answer must match the generated input");
      assert.deepEqual(deliveries.at(-1)?.message.content, outcome.finalContent, "Final delivery must contain the validated model result");
      report.status = "passed";
    } catch (error) {
      report.error = error instanceof Error ? error.message : "Unknown failure";
    } finally {
      report.durationMs = Date.now() - start;
      results.push(report);
      await save();
      console.log(JSON.stringify(report));
    }
  };

  try {
    const code = `PICKUP-${randomBytes(6).toString("hex")}`;
    const count = randomInt(2, 50);
    await runCase("pipeline", { code, count }, async () => {
      const plan = pipelineGraph
        .node("answered", "INFER.REASONING.SAMPLE", ["selected"], (_input, { selected }) => ({
          model,
          messages: [
            { role: "system", content: 'Read the supplied records. Return ONLY JSON with code (string) and count (number) for the pickup. Do not invent missing values.' },
            { role: "user", content: JSON.stringify(selected.context.items) },
          ],
        }))
        .node("delivered", "INTERACTION.OUTPUT", ["answered"], (_input, { answered }) => {
          const output = completed(answered);
          return { deliveryId: code, message: { role: "assistant", content: String(output.message.content) } };
        });
      const output = await runtime.run(plan, {
        items: [
          { id: "pickup", content: `Pickup code: ${code}. Pickup count: ${count}.` },
          { id: "unrelated", content: "Office opens at nine. Reference code: IGNORE-000; count: 999." },
        ],
        query: "pickup", limit: 1,
      });
      assert.deepEqual(output.selected.selectedItemIds, ["pickup"]);
      assert.equal(output.delivered.status, "accepted");
      assert.equal(deliveries.length, 1);
      return output.answered;
    });

    const originalCode = `OLD-${randomBytes(6).toString("hex")}`;
    const currentCode = `NEW-${randomBytes(6).toString("hex")}`;
    const currentCount = randomInt(51, 100);
    await runCase("dependencies", { originalCode, currentCode, currentCount }, async () => {
      const plan = dependenciesGraph
        .node("answered", "INFER.REASONING.SAMPLE", ["loaded", "selected", "delivered"], (_input, { loaded, selected, delivered }) => {
          assert.equal(delivered.status, "accepted", "Context delivery must finish before model interpretation");
          return { model, messages: [
            { role: "system", content: 'Compare the original and current records. Return ONLY JSON with originalCode (string), currentCode (string), currentCount (number). Preserve the codes exactly; use the current count.' },
            { role: "user", content: JSON.stringify({ original: loaded.items, current: selected.context.items }) },
          ] };
        })
        .node("final", "INTERACTION.OUTPUT", ["answered"], (_input, { answered }) => {
          const output = completed(answered);
          return { deliveryId: currentCode, message: { role: "assistant", content: String(output.message.content) } };
        });
      const input = {
        items: [{ id: "shipment", content: `Shipment code: ${originalCode}. Shipment count: 1.` }],
        additions: [{ id: "shipment", content: `Shipment code: ${currentCode}. Shipment count: ${currentCount}.` }],
        query: "shipment", limit: 1, deliveryId: `${currentCode}:context`,
      };
      const originalInput = structuredClone(input);
      const output = await runtime.run(plan, input);
      assert.deepEqual(input, originalInput);
      assert.deepEqual(output.loaded.items, originalInput.items);
      assert.deepEqual(output.updated.items, originalInput.additions);
      assert.deepEqual(output.selected.selectedItemIds, ["shipment"]);
      assert.deepEqual(deliveries[0]?.message.content, {
        originalItemIds: ["shipment"], selectedItemIds: ["shipment"],
        selectedContent: originalInput.additions.map(item => item.content),
      });
      assert.equal(output.final.status, "accepted");
      assert.equal(deliveries.length, 2);
      return output.answered;
    });

    const order = {
      code: `ORDER-${randomBytes(6).toString("hex")}`,
      quantity: randomInt(2, 10), unitPriceCents: randomInt(100, 1000),
    };
    await runCase("stages", { code: order.code, totalCents: order.quantity * order.unitPriceCents }, async () => {
      const output = await runStages(runtime, {
        id: order.code, model,
        text: `Order code ${order.code}: ${order.quantity} notebooks at ${order.unitPriceCents} cents each.`,
      });
      assert.deepEqual(output.order, order, "Preparation must extract the supplied order");
      assert.deepEqual(answer(output.prepared.extracted), order);
      assert.equal(output.completed.delivered.status, "accepted");
      assert.equal(deliveries.length, 1);
      const actual = answer(output.completed.summarized);
      return { samples: [output.prepared.extracted, output.completed.summarized], actual, finalContent: actual };
    });

    const records = Array.from({ length: 3 }, (_, index) => ({
      id: `item-${index}`, code: `BATCH-${randomBytes(6).toString("hex")}`, quantity: randomInt(1, 50),
    }));
    const expectedBatch = { items: records, totalQuantity: records.reduce((sum, item) => sum + item.quantity, 0) };
    await runCase("batch", expectedBatch, async () => {
      const input = {
        model, deliveryId: `batch-${randomBytes(6).toString("hex")}`,
        items: records.map(record => ({ id: record.id, text: `Pickup code ${record.code}; quantity ${record.quantity}.` })),
      };
      const snapshot = structuredClone(input);
      const output = await runBatch(runtime, input);
      assert.deepEqual(input, snapshot);
      assert.equal(output.samples.length, records.length);
      assert.equal(output.receipt.status, "accepted");
      assert.equal(deliveries.length, 1, "Batch must deliver one combined summary");
      const actual = { items: output.results, totalQuantity: output.results.reduce((sum, item) => sum + item.quantity, 0) };
      return { samples: output.samples, actual, finalContent: actual };
    });
  } finally {
    await runtime.close();
  }
}
assert.equal(results.length, providers.length * 4, "Every provider must run all four examples");
if (results.some(result => result.status === "failed")) process.exitCode = 1;
