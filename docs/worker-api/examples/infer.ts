import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import {
  createInfer, createInferWorker, InMemoryInferCache, inferSampleNode,
  type InferClient, type ModelConfig, type TrajectoryInput, type ReflectInput,
  type DeliberateInput, type TrajectoryStrategy, type InferCacheProvider, type ModelProvider, type SampleInput,
} from "@codesoul-co/ditto/worker/infer";

import { ProviderRegistry, createHttpProvider, type HttpProviderOptions } from "@codesoul-co/ditto/worker/infer/providers";

// example: setup
export function setupInfer() {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const cache = new InMemoryInferCache({ maxEntries: 2_000 });
  const runtime = createDitto({ config, workers: [createInferWorker({ cache, concurrency: 4 })] });
  const infer = createInfer({ runtime, cache });
  return { runtime, infer }; // runtime.close() drains Workers; the application owns external clients.
}

// example: sample
export async function sample(infer: InferClient, model: ModelConfig) {
  const result = await infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Return the sum of 17 and 25." }],
    generation: { temperature: 0, maxTokens: 256 },
  });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return { message: result.output.message, finishReason: result.output.finishReason, usage: result.output.usage };
}

// example: actions
export async function sampleActions(infer: InferClient, model: ModelConfig) {
  return infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Read README.md using the available tool." }],
    actions: [{ name: "read_text", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      target: { kind: "tool", toolName: "read_text" } }],
  }); // Inspect output.actionRequests; SAMPLE does not execute them.
}

// example: trajectory
export async function trajectory(infer: InferClient, model: ModelConfig) {
  const result = await infer.reasoning.trajectory({ model,
    messages: [{ role: "user", content: "Compare two ways to batch database writes." }],
    strategy: { name: "cot", options: { rounds: 2 } },
    constraints: { maxSteps: 4, timeoutMs: 30_000 },
  });
  if (result.status !== "success" || result.output?.status !== "completed") {
    throw new Error(result.error?.code ?? result.output?.stopReason ?? result.status);
  }
  return result.output.result;
}

// example: strategies
export function strategyRequests(model: ModelConfig): TrajectoryInput[] {
  const messages: TrajectoryInput["messages"] = [{ role: "user", content: "Find the cheapest valid delivery route." }];
  return [
    { model, messages, strategy: { name: "cot", options: { rounds: 2 } } },
    { model, messages, strategy: { name: "long-cot", options: { rounds: 4 } } },
    { model, messages, strategy: { name: "tot", options: { breadth: 2, depth: 2, beamWidth: 2 } }, constraints: { maxSteps: 16 } },
    { model, messages, strategy: { name: "got", options: { breadth: 2, depth: 2 } }, constraints: { maxSteps: 16 } },
    { model, messages, strategy: { name: "self-consistency", options: { candidates: 3 } }, constraints: { maxSteps: 3 } },
  ]; // Run any one with infer.reasoning.trajectory(request).
}

// example: reflect
export async function reflectModes(infer: InferClient, model: ModelConfig, mode: ReflectInput["mode"]) {
  const result = await infer.reasoning.reflect({ model, mode,
    messages: [{ role: "user", content: "What is 2 + 2?" }],
    target: { result: { role: "assistant", content: "5" } },
    criteria: [{ id: "arithmetic", description: "The result must equal 4.", weight: 1 }],
  });
  // mode = "critique": assessment + issues; "verify": assessment.passed; "revise": revisedResult.
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return result.output;
}

// example: deliberate
export async function deliberateModes(infer: InferClient, model: ModelConfig, mode: NonNullable<DeliberateInput["mode"]>) {
  const result = await infer.reasoning.deliberate({ model, mode,
    objective: "Prefer a design with bounded memory and clear error handling.",
    candidates: [
      { id: "a", result: { role: "assistant", content: "Use bounded batches with explicit failures." } },
      { id: "b", result: { role: "assistant", content: "Buffer all records and retry indefinitely." } },
    ],
    ...(mode === "select" ? { selectCount: 1 } : {}),
  }); // mode: select / merge / consensus / debate.
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return { message: result.output.result, ids: result.output.selectedCandidateIds, assessments: result.output.assessments };
}

// example: cache
export async function cacheApis(infer: InferClient) {
  const key = { namespace: "tenant-a", scope: "sample", key: "model-and-input-hash:v1" };
  const written = await infer.cache.write({ key, value: { role: "assistant", content: "42" }, ttlMs: 60_000, tags: ["model-v1"] });
  const lookup = await infer.cache.lookup({ key });
  if (lookup.status === "success" && lookup.output?.hit) console.log(lookup.output.value);
  const byKey = await infer.cache.invalidate({ selector: { type: "key", key } });
  const byTag = await infer.cache.invalidate({ selector: { type: "tag", tag: "model-v1" } });
  const byNamespace = await infer.cache.invalidate({ selector: { type: "namespace", namespace: "tenant-a" } });
  return { written, lookup, byKey, byTag, byNamespace };
}

// example: execute
export async function executeInfer(infer: InferClient, model: ModelConfig) {
  return infer.execute("INFER.REASONING.SAMPLE", { model, messages: [{ role: "user", content: "Hello" }] }, { timeoutMs: 5_000 });
}

// example: streams
export async function streamApis(infer: InferClient, model: ModelConfig) {
  const sampleInput = { model, messages: [{ role: "user" as const, content: "Give a brief answer." }] };
  const trajectoryInput: TrajectoryInput = { ...sampleInput, strategy: { name: "cot" } };
  const reflectInput: ReflectInput = { model, mode: "verify", target: { result: { role: "assistant", content: "2 + 2 = 4" } } };
  const deliberateInput: DeliberateInput = { model, mode: "select", candidates: [{ id: "a", result: { role: "assistant", content: "4" } }] };
  // Each method has its own typed terminal output; consume one selected stream in production.
  for await (const event of infer.reasoning.sample.stream(sampleInput)) {
    if (event.type === "result") console.log(event.result.output?.message);
  }
  for await (const event of infer.reasoning.trajectory.stream(trajectoryInput)) {
    if (event.type === "step") console.log(event.step.id, event.step.parentIds);
    if (event.type === "result") console.log(event.result.output?.result);
  }
  for await (const event of infer.reasoning.reflect.stream(reflectInput)) {
    if (event.type === "result") console.log(event.result.output?.assessment);
  }
  for await (const event of infer.reasoning.deliberate.stream(deliberateInput)) {
    if (event.type === "result") console.log(event.result.output?.selectedCandidateIds);
  }
}

// example: cancel
export async function cancelInfer(infer: InferClient, model: ModelConfig) {
  const controller = new AbortController();
  controller.abort();
  return infer.reasoning.sample({ model, messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal, timeoutMs: 5_000 });
}

// example: cacheProvider
export async function cacheProviderApi(cache: InferCacheProvider = new InMemoryInferCache({ maxEntries: 100 })) {
  const key = { scope: "sample", key: "example" };
  await cache.write({ key, value: "cached message", ttlMs: 1_000 });
  const hit = await cache.lookup({ key }); // Raw CacheLookupOutput, not NodeResult.
  const invalidated = await cache.invalidate({ selector: { type: "key", key } });
  return { hit, invalidated };
}

// example: customStrategy
export const refineStrategy: TrajectoryStrategy = async ctx => {
  ctx.signal.throwIfAborted();
  const draft = await ctx.sample(ctx.messages, { summary: "Create a draft" });
  const revised = await ctx.sample([...ctx.messages, draft.message, { role: "user", content: "Correct mistakes and return the final answer." }], { parentIds: [draft.stepId] });
  const decision = await ctx.deliberate([
    { id: "draft", result: draft.message }, { id: "revised", result: revised.message },
  ], "select", { selectCount: 1, parentIds: [draft.stepId, revised.stepId] });
  ctx.step({ type: "decision", parentIds: [decision.stepId], summary: "Selected a checked answer" });
  return decision.result;
};
// createInfer({ runtime, strategies: { refine: refineStrategy } });
// infer.reasoning.trajectory({ model, messages, strategy: { name: "refine" } });

// example: providers
export async function providerRegistryApis(provider: ModelProvider, input: SampleInput) {
  const providers = new ProviderRegistry();
  const unregister = providers.register("primary", provider);
  try {
    const selected = providers.get("primary");
    return await selected.invoke(input, { signal: AbortSignal.timeout(5_000) });
  } finally { unregister(); }
}

// example: providerStream
export async function providerStream(provider: ModelProvider, input: SampleInput) {
  const signal = AbortSignal.timeout(5_000);
  if (!provider.stream) return provider.invoke(input, { signal });
  for await (const event of provider.stream(input, { signal })) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "result") return event.output;
  }
  throw new Error("Provider stream ended without a result");
}

// example: httpProvider
export function httpModelProvider(options: HttpProviderOptions) {
  return createHttpProvider(options);
}
// Example options: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",
//   apiKey: process.env.DITTO_SHARED_PROVIDER_OPENAI_API_KEY, sandbox: runtime.services.sandbox }
// Omit apiKey entirely when the endpoint has no authentication.

// example: scaffold
export function sampleDescriptor(infer: InferClient) {
  return inferSampleNode.define("INFER", input => infer.reasoning.sample(input));
}
