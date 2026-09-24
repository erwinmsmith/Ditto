import { cli, deliver, exampleRequest, extractInstruction, isMain, record, sampleGraph, validateRequest, type RecordValue, type Request, type Runner } from "./shared.ts";

export interface ConfidenceInput extends Request {
  readonly evidence: string;
  /** Application verifier uses independent evidence. The model does not score its own answer. */
  readonly assess: (value: RecordValue, attempt: number) => number | Promise<number>;
}
export function confidenceRoute(score: number) {
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("Confidence must be within [0, 1]");
  return score >= 0.9 ? "return" : score >= 0.7 ? "analyze" : score >= 0.4 ? "retry" : "escalate";
}
const initialGraph = sampleGraph("confidence-initial");
const analysisGraph = sampleGraph("confidence-analyze", `Reconcile the candidate with the additional authoritative evidence. Prefer the evidence when they disagree. ${extractInstruction}`);
const retryGraph = sampleGraph("confidence-retry", `Independently re-read the original source carefully. Discard previous guesses. ${extractInstruction}`);

/** At most one corrective model call. A failed reassessment escalates instead of looping forever. */
export async function runConfidence(runtime: Runner, input: ConfidenceInput) {
  validateRequest(input);
  const initial = await runtime.run(initialGraph, input);
  let value = record(initial.sample);
  const samples = [initial.sample];
  let score = await input.assess(value, 0);
  const route = confidenceRoute(score);
  if (route === "analyze" || route === "retry") {
    if (route === "analyze" && !input.evidence.trim()) throw new Error("Additional evidence is required for analysis");
    const output = await runtime.run(route === "analyze" ? analysisGraph : retryGraph, {
      ...input, text: route === "analyze" ? JSON.stringify({ candidate: value, evidence: input.evidence }) : input.text,
    });
    samples.push(output.sample);
    value = record(output.sample);
    score = await input.assess(value, 1);
    confidenceRoute(score); // Reject invalid verifier output before any delivery.
  }
  const content = { route, status: score >= 0.9 ? "returned" : "pending_human", score, ...value };
  const receipt = await deliver(runtime, input.id, content);
  return { content, samples, receipt };
}
if (isMain(import.meta.url)) await cli((runtime, model) => runConfidence(runtime, {
  ...exampleRequest, model, evidence: exampleRequest.text,
  assess: value => value.code === "PICKUP-731" && value.quantity === 3 ? 1 : 0,
}));
