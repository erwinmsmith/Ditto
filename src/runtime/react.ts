import type { DittoRuntime } from "./runtime.js";
import { graph } from "./graph.js";
import type { InputOf, NodeType } from "../contracts/node-contract-map.js";
import type { SampleInput, SampleOutput } from "../worker/infer/reasoning/sample/types.js";
import { validateSample, validateSampleOutput } from "../worker/infer/reasoning/sample/schema.js";
import type { ActionRequest, ActionTarget, InferCallOptions, Message, Observation, Usage } from "../worker/infer/types.js";
import { abortable, addUsage, errorInfo, InferError, number } from "../worker/infer/validation.js";

export interface ReactFlowInput extends SampleInput {
  constraints?: { maxSteps?: number; maxActionCalls?: number; maxTotalTokens?: number; timeoutMs?: number };
}
export interface ReactFlowResult {
  result: Message;
  samples: SampleOutput[];
  observations: Observation[];
  actionRequests: ActionRequest[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_action_calls" | "max_tokens" | "timeout" | "cancelled" | "dependency_failed" | "error";
  usage: Usage;
  error?: { code: string; message: string };
}
class Stop extends Error {
  constructor(readonly reason: ReactFlowResult["stopReason"]) { super(reason); }
}
/** Predefined Runtime graph flow: SAMPLE → declared action leaves → SAMPLE. Never an INFER strategy. */
export async function runReactFlow(
  runtime: Pick<DittoRuntime, "run" | "services">,
  input: ReactFlowInput,
  options: InferCallOptions & { graphId?: string } = {},
): Promise<ReactFlowResult> {
  validateSample(input);
  input = { ...input, generation: { ...runtime.services.config.infer.generation, ...input.generation } };
  const maxSteps = input.constraints?.maxSteps ?? runtime.services.config.maxTurns;
  const maxActions = input.constraints?.maxActionCalls ?? runtime.services.config.react.maxActionCalls ?? 16;
  const maxTokens = input.constraints?.maxTotalTokens ?? runtime.services.config.react.maxTotalTokens ?? Infinity;
  const timeoutMs = Math.min(input.constraints?.timeoutMs ?? Infinity, options.timeoutMs ?? runtime.services.config.timeoutMs);
  number(maxSteps, "maxSteps", 1, Number.MAX_SAFE_INTEGER, true); number(maxActions, "maxActionCalls", 0, Number.MAX_SAFE_INTEGER, true);
  if (input.constraints?.maxTotalTokens !== undefined) number(maxTokens, "maxTotalTokens", 1, Number.MAX_SAFE_INTEGER, true);
  for (const value of [input.constraints?.timeoutMs, options.timeoutMs, timeoutMs]) if (value !== undefined) number(value, "timeoutMs", 1, 2 ** 31 - 1, true);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("ReAct deadline exceeded", "TimeoutError")), timeoutMs);
  const graphId = options.graphId ?? "react";
  const sampleGraph = graph<SampleInput>(graphId).node("sample", "INFER.REASONING.SAMPLE", [], value => value);
  const messages = [...input.messages]; const seen = new Set<string>(); const pending = new Map<string, ActionRequest>();
  const output: ReactFlowResult = { result: { role: "assistant", content: "" }, samples: [], observations: [], actionRequests: [], status: "failed", stopReason: "error", usage: {} };
  let actionCalls = 0;
  try {
    for (let turn = 0; ; turn++) {
      signal.throwIfAborted();
      if (turn >= maxSteps) throw new Stop("max_steps");
      if ((output.usage.totalTokens ?? 0) >= maxTokens) throw new Stop("max_tokens");
      const remaining = maxTokens - (output.usage.totalTokens ?? 0);
      const request: SampleInput = { model: input.model, messages, generation: { ...input.generation,
        ...(Number.isFinite(remaining) ? { maxTokens: Math.min(input.generation?.maxTokens ?? remaining, remaining) } : {}) },
        ...(input.actions ? { actions: input.actions } : {}), ...(input.metadata ? { metadata: input.metadata } : {}) };
      const { sample } = await abortable(() => runtime.run(sampleGraph, request), signal);
      if (sample.status !== "success") throw new InferError(sample.error?.code ?? "MODEL_ERROR", sample.error?.message ?? "SAMPLE failed");
      validateSampleOutput(sample.output); const response = sample.output;
      output.samples.push(response); output.result = response.message; addUsage(output.usage, response.usage);
      for (const request of response.actionRequests ?? []) {
        const descriptor = input.actions?.find(a => a.name === request.name);
        if (!descriptor) throw new InferError("UNDECLARED_ACTION", `Undeclared action: ${request.name}`);
        if (seen.has(request.id)) throw new InferError("INVALID_MODEL_OUTPUT", "Action IDs must be unique throughout ReAct");
        seen.add(request.id); pending.set(request.id, { id: request.id, name: request.name, arguments: request.arguments });
      }
      if (Number.isFinite(maxTokens) && response.usage?.totalTokens === undefined && (response.usage?.inputTokens === undefined || response.usage.outputTokens === undefined)) throw new InferError("USAGE_UNAVAILABLE", "maxTotalTokens requires usage from every SAMPLE");
      if ((output.usage.totalTokens ?? 0) > maxTokens || response.finishReason === "length") throw new Stop("max_tokens");
      if (response.finishReason === "cancelled" || response.finishReason === "error") throw new InferError(response.finishReason === "cancelled" ? "CANCELLED" : "MODEL_ERROR", "SAMPLE did not complete");
      if (!pending.size) { output.stopReason = "completed"; output.status = "completed"; return output; }
      // Reserve a model turn to consume observations before starting external work.
      if (turn + 1 >= maxSteps) throw new Stop("max_steps");
      if ((output.usage.totalTokens ?? 0) >= maxTokens) throw new Stop("max_tokens");
      messages.push({ ...response.message, metadata: { ...response.message.metadata, actionRequests: [...pending.values()] } });
      for (const action of pending.values()) {
        signal.throwIfAborted(); if (actionCalls >= maxActions) throw new Stop("max_action_calls");
        const descriptor = input.actions!.find(candidate => candidate.name === action.name)!;
        const binding: ActionTarget = descriptor.target ?? { kind: "tool" };
        const target: NodeType = binding.kind === "tool" ? "INTERACTION.ACT.TOOL" : binding.kind === "mcp" ? "INTERACTION.ACT.MCP" : binding.node as NodeType;
        const value = binding.kind === "tool"
          ? { call: { id: action.id, name: binding.toolName ?? descriptor.name, arguments: action.arguments } }
          : binding.kind === "mcp"
            ? { operation: "invoke", server: binding.server, call: { id: action.id, name: binding.toolName, arguments: action.arguments } }
            : action.arguments;
        const actionGraph = graph<unknown>(graphId).node("action", target, [], value => value as InputOf<NodeType>);
        actionCalls++;
        try {
          const { action: result } = await abortable(() => runtime.run(actionGraph, value), signal);
          if (binding.kind === "node") {
            const envelope = result && typeof result === "object" && "status" in result ? result as unknown as Record<string, unknown> : undefined;
            if (envelope && ["failed", "cancelled", "timeout"].includes(String(envelope.status))) throw new InferError("DEPENDENCY_FAILED", "Action Node returned an unsuccessful result");
            pending.delete(action.id);
            messages.push({ role: "tool", content: JSON.stringify((envelope?.status === "success" ? envelope.output : result) ?? null), metadata: { actionRequestId: action.id, name: action.name } });
            continue;
          }
          const external = binding.kind === "mcp" ? (result as { result: import("../contracts/common.js").ExternalResult }).result : result as import("../contracts/common.js").ExternalResult;
          if (external?.callId !== action.id) throw new InferError("DEPENDENCY_FAILED", "Action result callId mismatch");
          const observeGraph = graph<unknown>(graphId).node("observation", "INTERACTION.OBSERVE", [], () => ({ result: external }));
          const { observation } = await abortable(() => runtime.run(observeGraph, undefined), signal);
          pending.delete(action.id); output.observations.push(observation);
          if (["cancelled", "timeout", "unknown"].includes(observation.status)) {
            if (observation.error) output.error = observation.error;
            throw new Stop("dependency_failed");
          }
          messages.push({ role: "tool", content: typeof observation.message.content === "string" ? observation.message.content : JSON.stringify(observation.message.content), metadata: { actionRequestId: observation.callId, name: action.name } });
        } catch (error) {
          if (error instanceof Stop) throw error;
          const info = signal.aborted ? errorInfo(signal.reason) : errorInfo(error);
          if (signal.aborted) throw signal.reason;
          pending.delete(action.id); output.error = info; throw new Stop("dependency_failed");
        }
      }
    }
  } catch (error) {
    const info = signal.aborted ? errorInfo(signal.reason) : errorInfo(error);
    output.stopReason = signal.aborted ? (info.code === "TIMEOUT" ? "timeout" : "cancelled") : error instanceof Stop ? error.reason : info.code === "TIMEOUT" ? "timeout" : info.code === "CANCELLED" ? "cancelled" : "error";
    output.status = output.samples.length ? "partial" : "failed";
    if (!(error instanceof Stop)) output.error = info;
    output.actionRequests = [...pending.values()]; return output;
  } finally { clearTimeout(timer); }
}
