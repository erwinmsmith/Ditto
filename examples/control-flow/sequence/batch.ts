import { pathToFileURL } from "node:url";
import { createDitto, graph, loop, loadRuntimeConfigFile, type DittoRuntime } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker, type ModelConfig, type NodeResult, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";

export interface BatchItem { readonly id: string; readonly text: string; }
export interface BatchInput {
  readonly items: readonly BatchItem[];
  readonly model: ModelConfig;
  readonly deliveryId: string;
}
export interface BatchResult {
  readonly id: string;
  readonly code: string;
  readonly quantity: number;
}
interface BatchState {
  readonly index: number;
  readonly results: readonly BatchResult[];
  readonly samples: readonly NodeResult<SampleOutput>[];
}
export const batchInput = {
  items: [
    { id: "first", text: "Pickup code PICKUP-101; quantity 2." },
    { id: "second", text: "Pickup code PICKUP-202; quantity 5." },
    { id: "third", text: "Pickup code PICKUP-303; quantity 3." },
  ],
  deliveryId: "batch-pickups",
};

export const batchItemGraph = graph<BatchItem & { model: ModelConfig }>("batch-item")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ sources: [{ id: input.id, content: input.text }] }))
  .node("extracted", "INFER.REASONING.SAMPLE", ["loaded"], (input, { loaded }) => ({
    model: input.model,
    messages: [
      { role: "system", content: "Extract the pickup record. Return ONLY JSON with code (string) and quantity (nonnegative integer). Preserve the code exactly." },
      { role: "user", content: JSON.stringify(loaded.items) },
    ],
  }));

export const batchSummaryGraph = graph<{ deliveryId: string; items: readonly BatchResult[] }>("batch-summary")
  .node("delivered", "INTERACTION.OUTPUT", [], input => {
    const totalQuantity = input.items.reduce((sum, item) => sum + item.quantity, 0);
    if (!Number.isSafeInteger(totalQuantity)) throw new Error("Batch total exceeds the safe integer range");
    return { deliveryId: input.deliveryId, message: { role: "assistant", content: {
      items: input.items.map(item => ({ id: item.id, code: item.code, quantity: item.quantity })), totalQuantity,
    } } };
  });

/** One Graph per object; Loop owns iteration and aggregation, and Runtime remains caller-owned. */
export async function runBatch(runtime: Pick<DittoRuntime, "run" | "loop">, input: BatchInput) {
  if (input.items.some(item => !item.id.trim()) || new Set(input.items.map(item => item.id)).size !== input.items.length) {
    throw new Error("Batch item IDs must be nonempty and unique");
  }
  let state: BatchState = { index: 0, results: [], samples: [] };
  // Loop always executes at least once. Empty batches go directly to an empty summary.
  if (input.items.length) {
    state = await runtime.loop(loop({
      graph: batchItemGraph,
      maxIterations: input.items.length,
      bind: (current: BatchState) => ({ ...input.items[current.index]!, model: input.model }),
      update: (current, { extracted }): BatchState => {
        if (extracted.status !== "success" || !extracted.output || extracted.output.finishReason !== "stop"
          || typeof extracted.output.message.content !== "string") {
          throw new Error(`Batch item did not complete: ${extracted.error?.code ?? extracted.status}`);
        }
        const value: unknown = JSON.parse(extracted.output.message.content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
        if (!value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string" || !value.code.trim()
          || !("quantity" in value) || typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity) || value.quantity < 0) {
          throw new Error("Invalid batch item result");
        }
        return {
          index: current.index + 1,
          results: [...current.results, { id: input.items[current.index]!.id, code: value.code, quantity: value.quantity }],
          samples: [...current.samples, extracted],
        };
      },
      done: current => current.index === input.items.length,
    }), state);
  }
  const summary = await runtime.run(batchSummaryGraph, { deliveryId: input.deliveryId, items: state.results });
  if (summary.delivered.status !== "accepted") throw new Error(`Delivery was not accepted: ${summary.delivered.status}`);
  return { results: state.results, samples: state.samples, receipt: summary.delivered };
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
  try { await runBatch(runtime, { ...batchInput, model: config.model }); }
  finally { await runtime.close(); }
}
