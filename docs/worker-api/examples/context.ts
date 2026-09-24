import {
  createContext, createContextWorker, createRedisContextStore, createContextExecution,
  createRagStrategy, contextLoadNode, ContextError, contextScopeKey,
  defaultSelect, deterministicCompress, isProtectedContextItem,
  type ContextStateStore, type RedisContextClient,
  type ContextServices, type ContextOptions, type ContextCompressor,
} from "@codesoul-co/ditto/worker/context";
import { createDitto, graph, loadRuntimeConfigFile, runRagFlow, runSkillFlow } from "@codesoul-co/ditto";
import type { Context as WorkingContext, ContextItem as WorkingItem } from "@codesoul-co/ditto/contracts";
import type { InferClient, ModelConfig } from "@codesoul-co/ditto/worker/infer";
import { createMemoryWorker, type MemoryResources } from "@codesoul-co/ditto/worker/memory";
import type { RetrievalSearchProvider, RetrievalTarget } from "@codesoul-co/ditto-retrieval";

// example: setup
export function setupContext(client: RedisContextClient) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const settings: ContextOptions = {
    ...(config.context.policy === undefined ? {} : { policy: config.context.policy }),
    redis: { client, ...config.context.cache },
  };
  return {
    context: createContext(settings),
    runtime: createDitto({ config, workers: [createContextWorker({ ...settings, concurrency: 16 })] }),
  };
}

// example: load
export async function loadContext() {
  return createContext().load({ sources: [
    { role: "system", content: "Answer using the supplied evidence." },
    { id: "goal", content: "Explain the API", metadata: { currentGoal: true } },
    { uri: "file:///workspace/api.md", mediaType: "text/markdown" },
  ] });
}

// example: select
export async function selectContext(context: WorkingContext) {
  const client = createContext();
  const infer = await client.select({ context, purpose: "infer", query: "API", limit: 8, maxTokens: 2048 });
  const memory = await client.select({ context, purpose: "memory", limit: 4 });
  return { infer, memory }; // { purpose, context, selectedItemIds }, not NodeResult.
}

// example: update
export async function updateContext(context: WorkingContext) {
  return createContext().update({ context, removeIds: ["old"],
    add: [{ id: "goal", content: "Explain the cache", metadata: { currentGoal: true } }],
    ingress: [{ id: "observation:call-1", sourceNode: "INTERACTION.OBSERVE", content: "file contents",
      metadata: { callId: "call-1", status: "success" } }],
  });
}

// example: compress
export async function compressContext(context: WorkingContext) {
  return createContext().compress({ context, maxItems: 32, maxTokens: 4096 });
}

// example: execute
export async function executeContext() {
  return createContext().execute("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] });
}

// example: cached
export async function cachedContext(store: ContextStateStore) {
  const client = createContext({ services: { stateStore: store } });
  const scope = { sessionId: "tenant-a:session-1", turnId: "turn-1" };
  await client.load({ scope, sources: [{ id: "goal", content: "Review API" }] });
  await client.update({ scope, add: [{ id: "evidence", content: "Relevant source" }] });
  const selected = await client.select({ scope, purpose: "infer", limit: 1 });
  await client.compress({ scope, maxItems: 16 });
  const full = await client.load({ scope });
  return { selected, full }; // SELECT does not persist its projection.
}

// example: redis
export async function redisStore(client: RedisContextClient) {
  const store = createRedisContextStore(client, { ttlMs: 60000, keyPrefix: "app:context:" });
  const scope = { sessionId: "session-2" };
  const before = await store.get(scope);
  const written = await store.compareAndSet(scope, before?.version, { items: [{ id: "a", content: "one" }] });
  // A stale version rejects with STATE_CONFLICT; the application decides whether to retry.
  const context = createContext({ services: { stateStore: store } });
  await context.update({ scope, expectedVersion: written.version, add: [{ id: "b", content: "two" }] });
  return { key: contextScopeKey(scope), latest: await store.get(scope) };
}

// example: services
export function contextServices(compressor: ContextCompressor): ContextServices {
  return {
    tokenEstimator: { estimate: content => Math.ceil(JSON.stringify(content).length / 4) },
    selector: { async select(input) {
      if (input.strategy?.kind !== "provider" || input.strategy.name !== "latest") {
        throw new ContextError("STRATEGY_UNAVAILABLE", "Unknown selector");
      }
      return [...input.context.items].reverse();
    } },
    compressor,
  };
}

// example: rag
export async function ragContext(context: WorkingContext, search: (query: unknown) => Promise<readonly WorkingItem[]>) {
  const ragStrategy = createRagStrategy({
    retrieve: { async retrieve(input) { return (await search(input.query)).map(item => ({ item })); } },
  });
  return createContext({ services: { ragStrategy } }).select({
    context, purpose: "infer", query: "API", strategy: { kind: "rag" }, limit: 5,
  });
}

// example: retrieval
export function contextRetrieval(provider: RetrievalSearchProvider, target: RetrievalTarget) {
  return createRagStrategy({ retrieve: { async retrieve(input) {
    const output = await provider.search({ query: { content: input.query ?? "" }, target, limit: 10 });
    return output.candidates.map(candidate => {
      const id = candidate.id ?? candidate.source?.ref;
      if (!id) throw new Error("Map retrieval candidates to stable Context IDs");
      return { item: {
      id,
      content: typeof candidate.content === "string" ? candidate.content : JSON.stringify(candidate.content),
      metadata: { ...(candidate.score === undefined ? {} : { relevance: candidate.score }) },
    } };
    });
  } } });
}

// example: infer
export async function contextToInfer(context: WorkingContext, infer: InferClient, model: ModelConfig) {
  const selected = await createContext().select({ context, purpose: "infer", limit: 16 });
  return infer.reasoning.sample({ model, messages: [
    ...selected.context.items.map(item => ({ role: "user" as const,
      content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
    })),
    { role: "user", content: "Explain the evidence." },
  ] });
}

// example: memory
export async function memoryToContext(resources: MemoryResources) {
  const runtime = createDitto({ workers: [createMemoryWorker(resources), createContextWorker()] });
  const plan = graph<string>("memory-context")
    .node("search", "MEMORY.SEARCH", [], query => ({ query, limit: 5 }))
    .node("context", "CONTEXT.UPDATE", ["search"], (_query, { search }) => {
      if (search.status !== "success" || !search.output) throw new Error(search.error?.code ?? search.status);
      return { context: { items: [] }, ingress: search.output.map(hit => ({
        id: `memory:${hit.memory.id}`, sourceNode: "MEMORY.SEARCH" as const,
        content: typeof hit.memory.content === "string" ? hit.memory.content : JSON.stringify(hit.memory.content),
        metadata: { memoryId: hit.memory.id, ...(hit.score === undefined ? {} : { relevance: hit.score }) },
      })) };
    });
  try { return await runtime.run(plan, "language preference"); }
  finally { await runtime.close(); }
}

// example: flows
export async function contextFlows(services: ContextServices) {
  const runtime = createDitto({ workers: [createContextWorker({ services })] });
  try {
    const skill = await runSkillFlow(runtime, { sources: [{ id: "review-skill", content: "Check correctness." }] });
    return await runRagFlow(runtime, { context: skill.context, query: "API", limit: 5 });
  } finally { await runtime.close(); }
}

// example: errors
export async function contextErrors() {
  try { await createContext().load({ scope: { sessionId: "one" } }); }
  catch (error) {
    if (error instanceof ContextError) return error.code; // STATE_STORE_UNAVAILABLE
    throw error;
  }
}

// example: strategies
export async function directStrategies(context: WorkingContext) {
  const execution = createContextExecution({ maxItems: 16 });
  const ordered = await defaultSelect({ context, purpose: "infer" });
  const compressed = await deterministicCompress({ context, maxItems: 8 }, execution);
  return { ordered, compressed, protectedIds: context.items.filter(isProtectedContextItem).map(item => item.id) };
}

// example: scaffold
export const customContextLoad = contextLoadNode.define("CONTEXT", async input => createContext().load(input));

// example: durable
export async function contextToMemory(context: WorkingContext, memory: ReturnType<typeof import("@codesoul-co/ditto/worker/memory").createMemory>) {
  const selected = await createContext().select({ context, purpose: "memory", limit: 8 });
  return memory.write({ memories: selected.context.items.map(item => ({
    content: item.content, metadata: { contextItemId: item.id },
  })) });
}

// example: interaction
export async function toolToCachedContext(
  runtime: import("@codesoul-co/ditto").RuntimeClient,
  scope: import("@codesoul-co/ditto/worker/context").ContextScope,
  call: import("@codesoul-co/ditto/contracts").ToolCall,
) {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call });
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result });
  // The application chooses whether failed observations should enter its working set.
  if (observation.status !== "success") throw new Error(observation.error?.code ?? observation.status);
  return runtime.invoke("CONTEXT.UPDATE", { scope, ingress: [{
    id: `observation:${call.id}`, sourceNode: "INTERACTION.OBSERVE", content: observation.message.content,
    metadata: { callId: call.id, source: observation.source, status: observation.status },
  }] });
}

// example: remote
export function remoteContextRetrieval(runtime: import("@codesoul-co/ditto").RuntimeClient, target: RetrievalTarget) {
  return contextRetrieval({ async search(input) {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", input);
    if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
    return result.output;
  } }, target);
}
