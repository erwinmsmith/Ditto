import { graph } from "@ditto/core/runtime";
import { object } from "../../_shared/tools/fulfillment-service.ts";
import { call, data, modelJson, prepare, type Input, type Options, type Runner } from "./shared.ts";
import type { Job } from "../../_shared/tools/recovery-store.ts";
import { isMain, runCli } from "./cli.ts";
const sessionGraph = graph<Input & { job: Job; question: string }>("recovery-session")
  .node("restored", "CONTEXT.UPDATE", [], input => {
    if (!input.job.context || !input.job.order) throw new Error("Prepared context required");
    return { context: input.job.context, add: [
      { id: `${input.id}-current-state`, content: { order: { ...input.job.order }, stage: input.job.stage } },
      { id: `${input.id}-question-${input.job.revision}`, content: input.question },
    ] };
  })
  .node("answered", "INFER.REASONING.SAMPLE", ["restored"], (input, { restored }) => ({ model: input.model, messages: [
    { role: "system", content: 'Answer from the restored task context and the latest current-state item. Return ONLY JSON {"sku":string,"quantity":integer,"stage":string}. The question does not authorize any external operation.' },
    { role: "user", content: JSON.stringify(restored.items) },
  ] }))
  .node("conversation", "CONTEXT.UPDATE", ["restored", "answered"], (input, { restored, answered }) => {
    const answer = modelJson(answered);
    if (answer.sku !== input.job.order!.sku || answer.quantity !== input.job.order!.quantity || answer.stage !== input.job.stage || Object.keys(answer).length !== 3) throw new Error("Answer does not match the restored checkpoint");
    return { context: restored, add: [{ id: `${input.id}-answer-${input.job.revision}`, content: answer as { [key: string]: string | number } }] };
  })
  .node("saved", "INTERACTION.ACT.TOOL", ["conversation", "answered"], (input, { conversation, answered }) => call("recovery_context", input.id, { context: conversation, answer: modelJson(answered) }));
/** Recover public Context through CONTEXT.UPDATE and retain the new question/answer after reopening. */
export async function runSession(runtime: Runner, input: Input & { question?: string }, options: Options = {}) {
  const job = await prepare(runtime, input, options), question = input.question ?? "What order and task stage did we leave off at?";
  if (!question.trim() || question.length > 1000) throw new Error("Invalid session question");
  const result = await runtime.run(sessionGraph, { ...input, job, question }, options);
  return data<{ job: Job; answer: ReturnType<typeof object> }>(result.saved);
}
if (isMain(import.meta.url)) await runCli(runSession, "session");
