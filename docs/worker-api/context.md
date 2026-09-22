# CONTEXT Worker API

**English** · [简体中文](context.zh-CN.md) · [Worker API](README.md)

CONTEXT manages working context through LOAD, SELECT, UPDATE, and COMPRESS. Calls either transform an explicit Context or address temporary cached state by scope. Redis is the default cache adapter when an application-owned client is injected; ContextStateStore supports replaceable backends. `createContext()` opens no connections. Only scoped calls access the configured cache. MEMORY owns durable database records.

## Construction and configuration

Import factories from `@ditto/core/worker/context` or the root package; import Context, ContextItem, Message and Reference from `@ditto/core/contracts`. `createContext(options?)` and `createContextWorker(options?)` share handlers. Results are Context or ContextSelection, without a NodeResult envelope. Failures reject with ContextError or infrastructure/provider errors.

| Option | Default / behavior |
| --- | --- |
| policy.maxInlineBytes | 65536 JSON UTF-8 bytes per content; referenced items may exceed it |
| policy.maxItems | 256; final LOAD/UPDATE size and SELECT/COMPRESS ceiling |
| policy.maxTokens | Unset; SELECT/COMPRESS only, no automatic LOAD/UPDATE compression |
| policy.duplicate | replace / keep-first / reject; replacement preserves insertion position |
| policy.missingRemoval | ignore / reject |
| services | Token estimator, selector, compressor, RAG, stateStore and operationQueue |
| redis | `{ client, ttlMs?, keyPrefix? }`; mutually exclusive with services.stateStore |
| servicesFactory | Worker only; invoked once per local replica, takes precedence over services |
| concurrency | Worker only; positive integer, unlimited by default |

Use root YAML `workers.context.policy` for policy and `workers.context.cache` for ttlMs/keyPrefix. The loader exposes `config.context`; pass it explicitly when constructing clients and Workers. The application reads `.env`'s `DITTO_WORKER_CONTEXT_REDIS_URL` to construct its Redis SDK client. Config loading neither opens Redis nor implicitly loads `.env`. The application owns connect/close; Runtime.close() does not close injected Redis clients.

## Data and operations

```ts
interface ContextItem {
  id: string;
  content: MessageContent;
  source?: Reference;
  metadata?: JsonObject;
}
interface Context { items: readonly ContextItem[] }
interface ContextSelection {
  purpose: "infer" | "memory";
  context: Context;
  selectedItemIds: readonly string[];
}
```

| SDK / Node | Input | Result and semantics |
| --- | --- | --- |
| load / CONTEXT.LOAD | `{ sources: (Message \| Reference \| ContextItem)[], resolveReferences?: boolean }` | Context; canonical hashes supply stable Message/Reference IDs; Message role/name become metadata; references are only fetched when resolveReferences=true |
| update / CONTEXT.UPDATE | `{ context, removeIds?, add?, ingress? }` | Context; remove, add, then ingress in that order; ingress has id/sourceNode/content/reference?/metadata? and records sourceNode in metadata |
| select / CONTEXT.SELECT | `{ context, purpose, query?, limit?, maxTokens?, strategy? }` | ContextSelection; deduplicate, cap items and tokens; no state/Memory/model mutation |
| compress / CONTEXT.COMPRESS | `{ context, maxItems?, maxTokens? }` | Context; deterministic group removal, no model summarization by default |
| execute | `execute(node, input, options?)` | Typed dispatch to the four leaves |

Results are independent, deeply frozen snapshots. IDs must be nonempty; explicit Context IDs must be unique; content must be finite, acyclic JSON. Request limit/maxItems/maxTokens allow 0 through 1000000. Numeric policy values are positive and at most 1000000. Requests cannot relax policy caps.

The default SELECT strategy (`{ kind: "default" }`) prioritizes system/protected/currentGoal for infer, or memoryCandidate/reusable/stable for memory while excluding private=true and memoryEligible=false. Additional scoring uses priority, relevance, query token overlap and position. Items that do not fit the token budget are skipped. SELECT is not a safety policy; even protected items can be skipped. The fallback token estimate is ceil(JSON UTF-8 bytes / 4), not a model tokenizer.

COMPRESS protects protected/safety/currentGoal/pending=true or role=system items. Equal nonempty callId values form atomic groups. Low priority/relevance, retrievable and older groups are removed first, preserving remaining order. Unsatisfiable protected groups raise BUDGET_UNSATISFIABLE. Without a token budget it skips token estimation. Custom compressors cannot introduce IDs, remove protected items or split callId groups; their output must satisfy item, inline and token limits.

## Optional cached state

Use `scope: { sessionId?, turnId?, invocationId? }`, with at least one nonempty identifier. The full tuple identifies a key: sessionId alone shares across turns; adding turnId isolates them. There is no parent-scope fallback or implicit Runtime request-ID mapping. Applications enforce tenant ownership and authorization, for example with tenant-qualified session IDs. Scope is not a credential.

| Call | Cached behavior |
| --- | --- |
| LOAD `{ scope, sources }` | Create or replace; sources=[] explicitly clears content |
| LOAD `{ scope }` | Read full state; missing/expired state raises CONTEXT_NOT_FOUND |
| UPDATE `{ scope, add?, ingress?, removeIds? }` | Read, compute, compare-and-set against the observed version |
| SELECT `{ scope, purpose, ... }` | Read and project without writing or refreshing TTL |
| COMPRESS `{ scope, ... }` | Read, compress, compare-and-set |

Do not combine scope and context. Only initialization LOAD creates missing state. Optional expectedVersion checks the read version. A mutation uses one read and one atomic CAS, with no automatic retry. Concurrent changes raise STATE_CONFLICT; reload and decide whether retrying is appropriate. Results remain Context/ContextSelection; use stateStore.get() when you need the version. Do not blindly replay business side effects on conflict.

Redis defaults: keyPrefix=`ditto:context:`, ttlMs=3600000. Keys append the identifier tuple's SHA-256. Each scope stores one JSON string with a random UUID version. Successful writes refresh TTL; reads do not. Expiry, eviction or Redis restart may remove temporary state. A single-key Lua script checks the version and SETs with PX, supporting single-key Redis Cluster routing without distributed locks or timers. See [Redis EVAL](https://redis.io/docs/latest/commands/eval/).

### Storage port

```ts
interface ContextStateStore {
  get(scope: ContextScope, options?: ContextCallOptions): Promise<StoredContext | undefined>;
  compareAndSet(scope: ContextScope, expectedVersion: string | undefined, next: Context, options?: ContextCallOptions): Promise<StoredContext>;
}
interface StoredContext { version: string; context: Context }
interface RedisContextClient {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
```

Undefined expectedVersion means create only if missing; a supplied version must match or throw STATE_CONFLICT. External stores must implement atomic CAS and fresh versions to avoid ABA after expiration. `createRedisContextStore(client, options?)` also works independently. Connected node-redis clients match this port; other SDKs need get/eval forwarding functions.

Optional `ContextOperationQueue.enqueue(scope, operation, options?)` wraps cached calls. Use `createContextOperationQueue()` for bounded process-local serialization, or inject your own implementation. Storage CAS still enforces cross-process consistency.

## Strategy services

| Service / factory | Contract |
| --- | --- |
| tokenEstimator.estimate(content) | Nonnegative safe integer or Promise; skipped without a budget |
| selector.select(input) | Handles `{ kind: "provider", name, options? }`; resolves name and returns ContextItem[] |
| ragStrategy.select(input) | Handles `{ kind: "rag", corpus?: Reference, options? }`; query is MessageContent |
| createRagStrategy({ embed?, retrieve, rank? }) | Optional embed → required retrieve → optional rank; first item per ID wins; no extra Nodes |
| embed.embed({ query?, items, corpus?, options? }) | Arbitrary embedding passed to retrieve |
| retrieve.retrieve({ query?, items, corpus?, options?, embedding? }) | Returns `{ item: ContextItem, score?, metadata? }[]` |
| rank.rank({ query?, items, corpus?, options?, candidates }) | Returns candidates in selection priority order |
| compressor.compress(input) | Context preserving permitted IDs, protected items, correlated groups and budgets |
| referenceResolver.resolve(reference) | Used by LOAD with resolveReferences=true; otherwise references remain unresolved |

Candidate score/metadata are not automatically copied into item.metadata; explicitly map score to relevance if needed. SELECT returns a view; use UPDATE to persist additions. Reuse database search directly or delegate retrieve to an independent RETRIEVAL Worker, checking NodeResult and mapping complete ContextItems. Map unknown Memory/retrieval content explicitly into text/JSON.

`defaultSelect(input)`, `deterministicCompress(input, execution)` and `isProtectedContextItem(item)` support custom strategies. `createContextExecution(policy?, services?)` resolves frozen policy. Calling low-level strategy functions bypasses full SDK input/output validation.

Node descriptors `contextLoadNode`, `contextSelectNode`, `contextUpdateNode` and `contextCompressNode` expose `.type` and `.define(workerType, handler)` without registering a Worker. Low-level `loadNode/selectNode/updateNode/compressNode(input, execution)` take explicit input and ContextExecution; cached routing is supplied by createContext/createContextWorker. Prefer factories for normal use and leaf handlers for custom Worker reuse.

## Graphs and other Workers

- MEMORY.SEARCH → check NodeResult → map → CONTEXT.UPDATE. For durable writes, SELECT purpose=memory and explicitly map to MEMORY.WRITE.
- SELECT purpose=infer → map messages → INFER. INFER's ContextItem differs from the working ContextItem, including source type.
- INTERACTION.ACT.TOOL/MCP → OBSERVE → UPDATE; cached Graph bindings can pass scope at UPDATE.
- `runRagFlow(runtime, { context, query?, corpus?, limit?, maxTokens?, options? })` invokes SELECT's rag strategy and returns `{ output: ContextSelection, context }`.
- `runSkillFlow(runtime, { sources, context? })` LOADs resolved Skill content, then UPDATEs if context is supplied. Returns `{ output: Context, context }`; the application resolves Skill files and permissions.

These two helpers take explicit Context; cached Graphs can invoke the four nodes directly. Tools and models are not part of the default CONTEXT execution path.

## Errors and examples

| code | Meaning |
| --- | --- |
| INVALID_INPUT / UNKNOWN_NODE | Invalid input/node |
| INLINE_LIMIT_EXCEEDED / ITEM_LIMIT_EXCEEDED | Content/item limit exceeded |
| DUPLICATE_ITEM / MISSING_ITEM | Duplicate/removal policy rejection |
| STRATEGY_UNAVAILABLE | Missing or unsupported strategy |
| INVALID_PROVIDER_OUTPUT | Invalid selector/compressor/estimator result |
| BUDGET_UNSATISFIABLE | Protected items exceed budget |
| STATE_STORE_UNAVAILABLE / CONTEXT_NOT_FOUND | No store or missing state |
| STATE_CONFLICT / INVALID_STATE | Version conflict or corrupt stored data |

ContextError exposes code/message. Redis SDK, user-service, Runtime routing and transport exceptions can also reject directly. There are no background retries or successful empty results hiding failures.

Complete callable source: [examples/context.ts](examples/context.ts). Functions share the imports below and do not execute on import. See the [example guide](../../examples/README.md#context--redis) for SDK installation and connection.

```ts
import {
  createContext, createContextWorker, createRedisContextStore, createContextExecution,
  createRagStrategy, contextLoadNode, ContextError, contextScopeKey,
  defaultSelect, deterministicCompress, isProtectedContextItem,
  type ContextStateStore, type RedisContextClient,
  type ContextServices, type ContextOptions, type ContextCompressor,
} from "@ditto/core/worker/context";
import { createDitto, graph, loadRuntimeConfigFile, runRagFlow, runSkillFlow } from "@ditto/core";
import type { Context as WorkingContext, ContextItem as WorkingItem } from "@ditto/core/contracts";
import type { InferClient, ModelConfig } from "@ditto/core/worker/infer";
import { createMemoryWorker, type MemoryResources } from "@ditto/core/worker/memory";
import type { RetrievalSearchProvider, RetrievalTarget } from "@ditto/core/worker/retrieval";
```

### Construct SDK and Worker

```ts
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
```

### LOAD: messages, items and references

```ts
export async function loadContext() {
  return createContext().load({ sources: [
    { role: "system", content: "Answer using the supplied evidence." },
    { id: "goal", content: "Explain the API", metadata: { currentGoal: true } },
    { uri: "file:///workspace/api.md", mediaType: "text/markdown" },
  ] });
}
```

### SELECT: infer and memory purposes

```ts
export async function selectContext(context: WorkingContext) {
  const client = createContext();
  const infer = await client.select({ context, purpose: "infer", query: "API", limit: 8, maxTokens: 2048 });
  const memory = await client.select({ context, purpose: "memory", limit: 4 });
  return { infer, memory }; // { purpose, context, selectedItemIds }, not NodeResult.
}
```

### UPDATE: changes and provenance

```ts
export async function updateContext(context: WorkingContext) {
  return createContext().update({ context, removeIds: ["old"],
    add: [{ id: "goal", content: "Explain the cache", metadata: { currentGoal: true } }],
    ingress: [{ id: "observation:call-1", sourceNode: "INTERACTION.OBSERVE", content: "file contents",
      metadata: { callId: "call-1", status: "success" } }],
  });
}
```

### COMPRESS: budgets

```ts
export async function compressContext(context: WorkingContext) {
  return createContext().compress({ context, maxItems: 32, maxTokens: 4096 });
}
```

### execute: typed dispatch

```ts
export async function executeContext() {
  return createContext().execute("CONTEXT.LOAD", { sources: [{ role: "user", content: "hello" }] });
}
```

### Cached calls to all four nodes

```ts
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
```

### Redis store and explicit versions

```ts
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
```

### Inject custom services

```ts
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
```

### RAG strategy

```ts
export async function ragContext(context: WorkingContext, search: (query: unknown) => Promise<readonly WorkingItem[]>) {
  const ragStrategy = createRagStrategy({
    retrieve: { async retrieve(input) { return (await search(input.query)).map(item => ({ item })); } },
  });
  return createContext({ services: { ragStrategy } }).select({
    context, purpose: "infer", query: "API", strategy: { kind: "rag" }, limit: 5,
  });
}
```

### Reuse a RETRIEVAL provider

```ts
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
```

### Pass context to INFER

```ts
export async function contextToInfer(context: WorkingContext, infer: InferClient, model: ModelConfig) {
  const selected = await createContext().select({ context, purpose: "infer", limit: 16 });
  return infer.reasoning.sample({ model, messages: [
    ...selected.context.items.map(item => ({ role: "user" as const,
      content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
    })),
    { role: "user", content: "Explain the evidence." },
  ] });
}
```

### MEMORY and Context Graph

```ts
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
```

### RAG and Skill flows

```ts
export async function contextFlows(services: ContextServices) {
  const runtime = createDitto({ workers: [createContextWorker({ services })] });
  try {
    const skill = await runSkillFlow(runtime, { sources: [{ id: "review-skill", content: "Check correctness." }] });
    return await runRagFlow(runtime, { context: skill.context, query: "API", limit: 5 });
  } finally { await runtime.close(); }
}
```

### Error handling

```ts
export async function contextErrors() {
  try { await createContext().load({ scope: { sessionId: "one" } }); }
  catch (error) {
    if (error instanceof ContextError) return error.code; // STATE_STORE_UNAVAILABLE
    throw error;
  }
}
```

### Reuse built-in strategies

```ts
export async function directStrategies(context: WorkingContext) {
  const execution = createContextExecution({ maxItems: 16 });
  const ordered = await defaultSelect({ context, purpose: "infer" });
  const compressed = await deterministicCompress({ context, maxItems: 8 }, execution);
  return { ordered, compressed, protectedIds: context.items.filter(isProtectedContextItem).map(item => item.id) };
}
```

### Custom node descriptor

```ts
export const customContextLoad = contextLoadNode.define("CONTEXT", async input => createContext().load(input));
```

### Write to durable MEMORY

```ts
export async function contextToMemory(context: WorkingContext, memory: ReturnType<typeof import("@ditto/core/worker/memory").createMemory>) {
  const selected = await createContext().select({ context, purpose: "memory", limit: 8 });
  return memory.write({ memories: selected.context.items.map(item => ({
    content: item.content, metadata: { contextItemId: item.id },
  })) });
}
```

### Write tool observations to cached Context

```ts
export async function toolToCachedContext(
  runtime: import("@ditto/core").RuntimeClient,
  scope: import("@ditto/core/worker/context").ContextScope,
  call: import("@ditto/core/contracts").ToolCall,
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
```

### Delegate to independent RETRIEVAL

```ts
export function remoteContextRetrieval(runtime: import("@ditto/core").RuntimeClient, target: RetrievalTarget) {
  return contextRetrieval({ async search(input) {
    const result = await runtime.invoke("RETRIEVAL.SEARCH", input);
    if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
    return result.output;
  } }, target);
}
```

Runnable database integration examples: [examples/worker](../../examples/worker/README.md), including SDK installation, env settings, invocation and cleanup.

## Local cache, queues and reference loading

`createInMemoryContextStore({ ttlMs?, maxEntries?, now? })` implements the same get/CAS port as Redis. Defaults are 3600000 ms and 1000 scopes. TTL must be 1–2147483647; maxEntries is a positive safe integer. `now` is an injectable millisecond clock. Reads update LRU order without extending TTL; writes refresh TTL, remove expired entries under capacity pressure, then evict the least recently used scope if needed. Values are immutable snapshots. There are no connections or background timers; state disappears with the process.

`createContextOperationQueue({ maxPending? })` defaults to 1024 pending/running operations across all scopes. Same-scope operations serialize; different scopes progress independently. Capacity exhaustion rejects with QUEUE_FULL. Failed jobs release capacity and do not block later jobs. Cancellation is checked before enqueue and at execution; canceled waiting jobs retain their slot until earlier jobs drain. Share the same queue/store instances across local replicas when they share state. A queue is not a distributed lock.

`load({ sources, resolveReferences: true })` resolves bare Reference entries in input order through `services.referenceResolver.resolve(reference, options?)`. The flag defaults to false and requires sources and a resolver. Existing Message/ContextItem values are unchanged. Resolved items retain the original stable ID and source URI, must be finite acyclic JSON and fit maxInlineBytes. Missing resolver raises RESOLVER_UNAVAILABLE; invalid output raises INVALID_PROVIDER_OUTPUT; excessive content raises INLINE_LIMIT_EXCEEDED. Resolver implementations own URI authorization and bounded I/O. No scheme or network access is enabled implicitly.

```ts
import { createContext, createInMemoryContextStore, createContextOperationQueue,
  loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const store = createInMemoryContextStore(config.context.localCache);
const queue = createContextOperationQueue(config.context.queue);
const context = createContext({ services: {
  stateStore: store, operationQueue: queue,
  referenceResolver: { async resolve(reference, options) {
    options?.signal?.throwIfAborted();
    if (reference.uri !== "urn:goal") throw new Error("Unknown reference");
    return "Explain the retrieval pipeline";
  } },
} });
const scope = { sessionId: "example" };
await context.load({ scope, sources: [{ uri: "urn:goal" }], resolveReferences: true });
await Promise.all(["a", "b"].map(id => context.update({ scope, add: [{ id, content: id }] })));
const selected = await context.select({ scope, purpose: "infer", limit: 2 },
  { signal: AbortSignal.timeout(5000) });
const snapshot = await store.get(scope);
if (snapshot) await store.compareAndSet(scope, snapshot.version, snapshot.context);
await queue.enqueue(scope, async () => "application operation");
```

All SDK methods accept optional `ContextCallOptions` after input; execute accepts it as the third argument. `signal` propagates to selectors, RAG stages, compressors, token estimation, reference resolution, cache and queue ports. These ports accept options after their existing arguments (fourth for compareAndSet). Cancellation rejects the SDK call; cancellation before persistence prevents CAS. Cancellation cannot undo a completed external write. Runtime Workers supply the current signal and an invocation-bound `runtime` for nested delegation; applications normally only set signal.

For reusable inline or delegated database retrieval, see [Context retrieval adapter](retrieval-providers.md#context-retrieval-adapter) and the runnable [SQLite example](../../examples/worker/context-retrieval.ts).
