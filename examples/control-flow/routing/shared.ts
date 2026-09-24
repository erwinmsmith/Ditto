import { pathToFileURL } from "node:url";
import { createDitto, graph, loadRuntimeConfigFile, type DittoRuntime } from "@codesoul-co/ditto/runtime";
import { createInferWorker, type ModelConfig, type NodeResult, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import type { JsonObject } from "@codesoul-co/ditto/contracts";

export type Runner = Pick<DittoRuntime, "run">;
export interface Request { readonly id: string; readonly text: string; readonly model: ModelConfig }
export interface RecordValue { readonly code: string; readonly quantity: number }
export const extractInstruction = 'Extract the pickup record. Return ONLY JSON {"code":string,"quantity":integer}. Preserve the code exactly. Never invent missing fields.';
export const exampleRequest = { id: "pickup-731", text: "Pickup code PICKUP-731; quantity 3." };

export function json(result: NodeResult<SampleOutput>): Record<string, unknown> {
  if (result.status !== "success" || !result.output || result.output.finishReason !== "stop"
    || result.output.message.role !== "assistant" || typeof result.output.message.content !== "string") {
    throw new Error(`Model did not complete: ${result.error?.code ?? result.status}`);
  }
  const value: unknown = JSON.parse(result.output.message.content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
export function record(result: NodeResult<SampleOutput>): RecordValue {
  const value = json(result);
  if (typeof value.code !== "string" || !value.code.trim() || typeof value.quantity !== "number"
    || !Number.isSafeInteger(value.quantity) || value.quantity < 0) throw new Error("Invalid pickup record");
  return { code: value.code, quantity: value.quantity };
}
export function validateRequest(input: Request): void {
  if (!input.id.trim() || !input.text.trim()) throw new Error("Request id and text must be nonempty");
}
export function sampleGraph(id: string, instruction = extractInstruction) {
  return graph<Request>(id).node("sample", "INFER.REASONING.SAMPLE", [], input => ({
    model: input.model,
    messages: [{ role: "system", content: instruction }, { role: "user", content: input.text }],
  }));
}
export const deliveryGraph = graph<{ id: string; content: JsonObject }>("routing-delivery")
  .node("delivered", "INTERACTION.OUTPUT", [], input => ({
    deliveryId: input.id, message: { role: "assistant", content: input.content },
  }));
export async function deliver(runtime: Runner, id: string, content: JsonObject) {
  const output = await runtime.run(deliveryGraph, { id, content });
  if (output.delivered.status !== "accepted") throw new Error(`Delivery was not accepted: ${output.delivered.status}`);
  return output.delivered;
}
export function isMain(url: string): boolean {
  return !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
}
/** CLI bootstrap only. Importing an example performs no work. */
export async function cli(run: (runtime: DittoRuntime, model: ModelConfig) => Promise<unknown>, tools: readonly RegisteredTool[] = []) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  if (!config.model) throw new Error("Configure the default INFER model in .env");
  const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) }, workers: [
    createInferWorker(), createInteractionWorker({ tools, output: { async deliver(input) {
      console.log(JSON.stringify(input.message.content, null, 2));
      return { deliveryId: input.deliveryId, status: "accepted" };
    } } }),
  ] });
  try { await run(runtime, config.model); } finally { await runtime.close(); }
}
