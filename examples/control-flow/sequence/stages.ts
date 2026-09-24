import { pathToFileURL } from "node:url";
import { createDitto, graph, loadRuntimeConfigFile, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelConfig, type NodeResult, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";

export interface StagesInput {
  readonly id: string;
  readonly text: string;
  readonly model: ModelConfig;
}
export interface Order {
  readonly code: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}
export const stagesInput = {
  id: "staged-order",
  text: "Order code ORDER-731: 3 notebooks at 1200 cents each.",
};

function modelJson(result: NodeResult<SampleOutput>): unknown {
  if (result.status !== "success" || !result.output || result.output.finishReason !== "stop"
    || typeof result.output.message.content !== "string") {
    throw new Error(`Model did not complete: ${result.error?.code ?? result.status}`);
  }
  return JSON.parse(result.output.message.content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

export const preparationGraph = graph<StagesInput>("stage-prepare")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ sources: [{ id: input.id, content: input.text }] }))
  .node("extracted", "INFER.REASONING.SAMPLE", ["loaded"], (input, { loaded }) => ({
    model: input.model,
    messages: [
      { role: "system", content: "Extract the order. Return ONLY JSON with code (string), quantity (positive integer), unitPriceCents (nonnegative integer). Prices are in cents. Preserve the code exactly." },
      { role: "user", content: JSON.stringify(loaded.items) },
    ],
  }));

export const completionGraph = graph<{ id: string; model: ModelConfig; order: Order }>("stage-complete")
  .node("summarized", "INFER.REASONING.SAMPLE", [], input => ({
    model: input.model,
    messages: [
      { role: "system", content: "Calculate quantity times unitPriceCents. Return ONLY JSON with code (unchanged string) and totalCents (integer)." },
      { role: "user", content: JSON.stringify(input.order) },
    ],
  }))
  .node("delivered", "INTERACTION.OUTPUT", ["summarized"], (input, { summarized }) => {
    const summary = modelJson(summarized);
    if (!summary || typeof summary !== "object" || !("code" in summary) || summary.code !== input.order.code
      || !("totalCents" in summary) || summary.totalCents !== input.order.quantity * input.order.unitPriceCents) {
      throw new Error("Order summary does not match the prepared order");
    }
    return { deliveryId: input.id, message: { role: "assistant", content: { code: input.order.code, totalCents: summary.totalCents } } };
  });

/** The caller owns Runtime registration and cleanup. A stage must finish and validate before the next starts. */
export async function runStages(runtime: Pick<DittoRuntime, "run">, input: StagesInput) {
  const prepared = await runtime.run(preparationGraph, input);
  const value = modelJson(prepared.extracted);
  if (!value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string" || !value.code.trim()
    || !("quantity" in value) || typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity) || value.quantity < 1
    || !("unitPriceCents" in value) || typeof value.unitPriceCents !== "number" || !Number.isSafeInteger(value.unitPriceCents) || value.unitPriceCents < 0
    || !Number.isSafeInteger(value.quantity * value.unitPriceCents)) {
    throw new Error("Invalid prepared order");
  }
  const order: Order = { code: value.code, quantity: value.quantity, unitPriceCents: value.unitPriceCents };
  const completed = await runtime.run(completionGraph, { id: input.id, model: input.model, order });
  if (completed.delivered.status !== "accepted") throw new Error(`Delivery was not accepted: ${completed.delivered.status}`);
  return { order, prepared, completed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  if (!config.model) throw new Error("Configure the default INFER model in .env");
  const runtime = createDitto({ config, workers: [createContextWorker(), createInferWorker(), createInteractionWorker({ output: {
    async deliver(input) {
      console.log(JSON.stringify(input.message.content, null, 2));
      return { deliveryId: input.deliveryId, status: "accepted" };
    },
  } })] });
  try { await runStages(runtime, { ...stagesInput, model: config.model }); }
  finally { await runtime.close(); }
}
