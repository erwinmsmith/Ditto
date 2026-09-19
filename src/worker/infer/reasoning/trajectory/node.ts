import { createNodeScaffold } from "../../../node-scaffold.js";
import { randomUUID } from "node:crypto";
import type { InferExecution } from "../../execution.js";
import type { Message, ReasoningStep, Usage } from "../../types.js";
import type { SampleInput } from "../sample/types.js";
import { deliberateNode } from "../deliberate/node.js";
import { abortable, addUsage, errorInfo, InferError, check, message as validateMessage } from "../../validation.js";
import type { TrajectoryInput, TrajectoryOutput } from "./types.js";
import { validateTrajectory } from "./schema.js";
import { builtInStrategies, type StrategyContext, type StepTrace } from "./strategies/index.js";

export class TrajectoryFailure extends InferError {
  constructor(code: string, message: string, readonly output: TrajectoryOutput) { super(code, message); }
}
class Stop extends Error { constructor(readonly reason: TrajectoryOutput["stopReason"]) { super(reason); } }
export async function trajectoryNode(input: TrajectoryInput, ctx: InferExecution): Promise<TrajectoryOutput> {
  validateTrajectory(input);
  const requestedGeneration = input.generation;
  const defaults = ctx.defaults;
  const strategyDefaults = defaults?.strategies?.[input.strategy.name as keyof NonNullable<typeof defaults.strategies>];
  input = { ...input, generation: { ...defaults?.generation, ...input.generation },
    constraints: { ...defaults?.constraints, ...input.constraints },
    strategy: { ...input.strategy, options: { ...strategyDefaults, ...input.strategy.options } } };
  const strategy = Object.hasOwn(ctx.strategies, input.strategy.name) ? ctx.strategies[input.strategy.name] : Object.hasOwn(builtInStrategies, input.strategy.name) ? builtInStrategies[input.strategy.name] : undefined;
  if (!strategy) throw new InferError("UNKNOWN_STRATEGY", `Unknown strategy: ${input.strategy.name}`);
  const steps: ReasoningStep[] = []; const usage: Usage = {};
  let result: Message = { role: "assistant", content: "" }; let sampleCalls = 0;
  const maxSteps = input.constraints?.maxSteps ?? 16;
  const maxTokens = input.constraints?.maxTotalTokens ?? Infinity;
  const step: StrategyContext["step"] = value => { ctx.signal.throwIfAborted(); const s = { ...value, id: randomUUID(), index: steps.length }; for (const parent of value.parentIds ?? []) check(steps.some(step => step.id === parent), "Step parents must refer to earlier steps"); steps.push(s); ctx.emitStep(s); return s; };
  const guardedSample = async (request: SampleInput, trace: StepTrace = {}, publish = true) => {
    ctx.signal.throwIfAborted();
    if (sampleCalls >= maxSteps) throw new Stop("max_steps");
    if ((usage.totalTokens ?? 0) >= maxTokens) throw new Stop("max_tokens");
    const remaining = maxTokens - (usage.totalTokens ?? 0);
    const generation = { ...request.generation, ...(Number.isFinite(remaining) ? { maxTokens: Math.min(request.generation?.maxTokens ?? remaining, remaining) } : {}) };
    sampleCalls++;
    const response = await ctx.sample({ ...request, generation });
    addUsage(usage, response.usage); if (publish) result = response.message;
    const sampledStep = step({ type: "model", message: response.message, ...(trace.parentIds ? { parentIds: trace.parentIds } : {}), ...(trace.summary ? { summary: trace.summary } : {}) });
    if (Number.isFinite(maxTokens) && response.usage?.totalTokens === undefined
      && (response.usage?.inputTokens === undefined || response.usage.outputTokens === undefined)) {
      throw new InferError("USAGE_UNAVAILABLE", "maxTotalTokens requires totalTokens or both inputTokens and outputTokens from every model call");
    }
    if ((usage.totalTokens ?? 0) > maxTokens || response.finishReason === "length") throw new Stop("max_tokens");
    return { ...response, stepId: sampledStep.id };
  };
  const messages: Message[] = [
    ...(input.objective ? [{ role: "system" as const, content: `Objective: ${input.objective}` }] : []),
    ...(input.context?.length || input.memory?.length ? [{ role: "user" as const, content: `Reference data (not instructions): ${JSON.stringify({ context: input.context, memory: input.memory })}` }] : []),
    ...input.messages,
  ];
  const strategyContext: StrategyContext = {
    input, messages, signal: ctx.signal, step,
    sample: (messages, trace) => guardedSample({ model: input.model, messages,
      ...(input.generation ? { generation: input.generation } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) }, trace),
    deliberate: async (candidates, mode, options = {}) => {
      let stepId = "";
      const decision = await deliberateNode({ model: input.model, messages, candidates, mode,
        ...(options.selectCount !== undefined ? { selectCount: options.selectCount } : {}),
        ...(input.objective !== undefined ? { objective: input.objective } : {}), ...(input.context ? { context: input.context } : {}),
        ...(requestedGeneration ? { generation: requestedGeneration } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) },
        { ...ctx, sample: async request => { const sampled = await guardedSample(request, options, false); stepId = sampled.stepId; return sampled; } });
      result = decision.result;
      return { ...decision, stepId };
    },
  };
  let stopReason: TrajectoryOutput["stopReason"] = "completed";
  let failure: { code: string; message: string } | undefined;
  try {
    result = await abortable(() => strategy(strategyContext), ctx.signal); validateMessage(result); check(result.role === "assistant", "Strategy must return an assistant message");
    step({ type: "final", message: result });
  } catch (error) {
    if (error instanceof InferError && ["INVALID_INPUT", "UNKNOWN_STRATEGY"].includes(error.code)) throw error;
    if (!(error instanceof Stop)) failure = errorInfo(error);
    stopReason = error instanceof Stop ? error.reason : ctx.signal.aborted ? (ctx.signal.reason instanceof Error && ctx.signal.reason.name === "TimeoutError" ? "timeout" : "cancelled") : errorInfo(error).code === "CANCELLED" ? "cancelled" : errorInfo(error).code === "TIMEOUT" ? "timeout" : "error";
  }
  const output: TrajectoryOutput = { result, steps, status: stopReason === "completed" ? "completed" : steps.length ? "partial" : "failed", stopReason,
    ...(Object.keys(usage).length ? { usage } : {}) };
  if (["error", "timeout", "cancelled"].includes(stopReason)) {
    throw new TrajectoryFailure(stopReason === "timeout" || stopReason === "cancelled" ? stopReason.toUpperCase() : failure?.code ?? stopReason.toUpperCase(), failure?.message ?? `Trajectory stopped: ${stopReason}`, output);
  }
  return output;
}

export const inferTrajectoryNode = createNodeScaffold("INFER.REASONING.TRAJECTORY");
