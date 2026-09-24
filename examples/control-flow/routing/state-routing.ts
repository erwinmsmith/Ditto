import { cli, deliver, exampleRequest, isMain, json, record, sampleGraph, validateRequest, type Request, type Runner } from "./shared.ts";

export interface StateRoutingInput extends Request {
  readonly task: "extract" | "count";
  readonly state: "ready" | "blocked";
}
const extraction = sampleGraph("condition-extract");
const counting = sampleGraph("condition-count", 'Read the pickup record. Return ONLY JSON {"quantity":integer}.');

/** Application-owned state takes precedence over the task type. Only the chosen Graph is run. */
export async function runStateRouting(runtime: Runner, input: StateRoutingInput) {
  validateRequest(input);
  if (!["extract", "count"].includes(input.task) || !["ready", "blocked"].includes(input.state)) throw new Error("Unknown task or state");
  if (input.state === "blocked") {
    const content = { route: "defer", status: "blocked" };
    const receipt = await deliver(runtime, input.id, content);
    return { content, samples: [], receipt };
  }
  const output = await runtime.run(input.task === "extract" ? extraction : counting, input);
  const value = input.task === "extract" ? record(output.sample) : json(output.sample);
  if (typeof value.quantity !== "number" || !Number.isSafeInteger(value.quantity) || value.quantity < 0) throw new Error("Invalid quantity");
  const content = input.task === "extract"
    ? { route: input.task, code: record(output.sample).code, quantity: value.quantity }
    : { route: input.task, quantity: value.quantity };
  const receipt = await deliver(runtime, input.id, content);
  return { content, samples: [output.sample], receipt };
}
if (isMain(import.meta.url)) await cli((runtime, model) => runStateRouting(runtime, {
  ...exampleRequest, model, task: "extract", state: "ready",
}));
