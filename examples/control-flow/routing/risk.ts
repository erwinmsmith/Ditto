import { graph } from "@codesoul-co/ditto/runtime";
import { createPickupTool } from "../../_shared/tools/pickup-ledger.ts";
import { cli, deliver, exampleRequest, isMain, record, sampleGraph, validateRequest, type RecordValue, type Request, type Runner } from "./shared.ts";

export interface RiskInput extends Request {
  /** Trusted application policy, never a model-generated permission. */
  readonly risk: number;
  readonly verify: (record: RecordValue) => boolean | Promise<boolean>;
}
export function riskRoute(risk: number) {
  if (!Number.isFinite(risk) || risk < 0 || risk > 100) throw new Error("Risk must be within [0, 100]");
  return risk < 25 ? "execute" : risk < 50 ? "verify" : risk < 75 ? "confirm" : "human";
}
const prepareGraph = sampleGraph("risk-prepare");
const executeGraph = graph<{ id: string; value: RecordValue }>("risk-execute")
  .node("action", "INTERACTION.ACT.TOOL", [], input => ({
    call: { id: input.id, name: "record_pickup", arguments: { id: input.id, ...input.value } },
  }));
export async function runRisk(runtime: Runner, input: RiskInput) {
  validateRequest(input);
  const route = riskRoute(input.risk);
  const prepared = await runtime.run(prepareGraph, input);
  const value = record(prepared.sample);
  let status: "executed" | "pending_confirmation" | "pending_human";
  let toolCalls = 0;
  if (route === "execute" || (route === "verify" && await input.verify(value) === true)) {
    const output = await runtime.run(executeGraph, { id: input.id, value });
    if (output.action.status !== "success") throw new Error(`Action did not succeed: ${output.action.status}`);
    status = "executed";
    toolCalls = 1;
  } else status = route === "confirm" ? "pending_confirmation" : "pending_human";
  const content = { route, status, ...value };
  const receipt = await deliver(runtime, input.id, content);
  return { content, samples: [prepared.sample], receipt, toolCalls };
}
/** Resume only after the application's trusted review adapter approves this exact payload. */
export async function resumeRisk(runtime: Runner, input: {
  readonly id: string; readonly value: RecordValue; readonly route: "confirm" | "human" | "verify";
  readonly authorize: (id: string, value: RecordValue) => boolean | Promise<boolean>;
}) {
  if (await input.authorize(input.id, input.value) !== true) throw new Error("Review authorization is required");
  const output = await runtime.run(executeGraph, { id: input.id, value: input.value });
  if (output.action.status !== "success") throw new Error(`Action did not succeed: ${output.action.status}`);
  const content = { route: input.route, status: "executed", ...input.value };
  const receipt = await deliver(runtime, input.id, content);
  return { content, samples: [], receipt, toolCalls: 1 };
}
if (isMain(import.meta.url)) {
  const ledger = new Map<string, RecordValue>();
  await cli((runtime, model) => runRisk(runtime, {
    ...exampleRequest, model, risk: 30,
    verify: value => value.code === "PICKUP-731" && value.quantity === 3,
  }), [createPickupTool(ledger)]);
}
