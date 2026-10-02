import { createNodeScaffold } from "../../../node-scaffold.js";
import type { InferExecution } from "../../execution.js";
import type { SampleInput, SampleOutput } from "./types.js";
import { validateSample, validateSampleOutput } from "./schema.js";
import { abortable, InferError } from "../../validation.js";
export async function sampleNode(input: SampleInput, ctx: InferExecution): Promise<SampleOutput> {
  validateSample(input);
  if (ctx.defaults?.generation) input = { ...input, generation: { ...ctx.defaults.generation, ...input.generation } };
  const name = input.model.provider ?? ctx.defaultProvider;
  const provider = ctx.providers.get(name);
  let output: SampleOutput | undefined;
  if (ctx.streaming && provider.stream) {
    const iterator = provider.stream(input, { signal: ctx.signal })[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(() => iterator.next(), ctx.signal);
        if (next.done) break;
        if (output) throw new InferError("INVALID_MODEL_OUTPUT", "Provider emitted after terminal result");
        if (next.value.type === "text_delta" && typeof next.value.delta === "string") ctx.emitDelta(next.value.delta);
        else if ((next.value.type === "reasoning_delta" || next.value.type === "action_delta") && typeof next.value.delta === "string") {
          // Progress is observable on ModelProvider, but is not public answer text.
          if (next.value.type === "action_delta" && (!Number.isSafeInteger(next.value.index) || next.value.index < 0)) throw new InferError("INVALID_MODEL_OUTPUT", "Invalid action delta index");
        }
        else if (next.value.type === "result") output = next.value.output;
        else throw new InferError("INVALID_MODEL_OUTPUT", "Unknown provider stream event");
      }
    } finally { if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {}); }
  } else {
    output = await abortable(() => provider.invoke(input, { signal: ctx.signal }), ctx.signal);
    if (ctx.streaming && typeof output?.message?.content === "string") ctx.emitDelta(output.message.content);
  }
  validateSampleOutput(output);
  if (output.finishReason === "cancelled") throw new InferError("CANCELLED", "Model generation cancelled");
  if (output.finishReason === "error") throw new InferError("MODEL_ERROR", "Model generation failed");
  const actions = output.actionRequests?.map(request => {
    const descriptor = input.actions?.find(a => a.name === request.name);
    if (!descriptor) throw new InferError("UNDECLARED_ACTION", `Model requested undeclared action: ${request.name}`);
    // Routing comes only from the caller's descriptors, never the model response.
    return { id: request.id, name: request.name, arguments: request.arguments };
  });
  return { message: output.message, finishReason: output.finishReason,
    ...(output.usage ? { usage: output.usage } : {}), ...(actions?.length ? { actionRequests: actions } : {}) };
}

export const inferSampleNode = createNodeScaffold("INFER.REASONING.SAMPLE");
