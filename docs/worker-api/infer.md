# INFER Worker API

**English** · [简体中文](infer.zh-CN.md) · [API index](README.md)

This reference describes the implementation in `src/worker/infer/`: model sampling, explicit reasoning trajectories, reflection, candidate deliberation, and inference caching. Graphs supply Context and Memory upfront. ReAct and other cross-Worker orchestration belong to Runtime graph flows. INFER does not execute tools, MCP, or shells.

Implementation lives in the existing `src/worker/infer/` on current `dev`, preserving its node scaffolds. Detailed INFER contracts supersede the initial scaffold signatures. Import them from `@ditto/core/worker/infer` or the root `Infer` type namespace. Other Workers retain their shared types; Graph bindings map their Context/Memory outputs to INFER fields.

## 1. Setup and lifecycle

```ts
import { createDitto, createInfer, createInferWorker,
  createHttpProvider } from "@ditto/core";

const runtime = createDitto({ sandbox: { network: ["https://api.openai.com"] } });
runtime.services.providers.register("openai", createHttpProvider({
  kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  sandbox: runtime.services.sandbox,
}));
runtime.register(createInferWorker());
const infer = createInfer({ runtime });
const input = {
  messages: [{ role: "user" as const, content: "Explain the tradeoffs." }],
  model: { provider: "openai", model: "your-model-name" },
};
const direct = await infer.reasoning.sample(input);
const routed = await runtime.invoke("INFER.REASONING.SAMPLE", input);
console.log(direct.output?.message, routed.status);
await runtime.close();
```

`createInfer` executes the same handlers locally; it is not a proxy to a registered Worker. Each SDK instance and Worker replica has its own cache by default. Inject a shared backend to share data between SDKs, replicas, or processes. Call deadline timers are cleaned up after execution. The application owns injected provider/cache connections and their cleanup.

| `InferOptions` | Meaning / default |
| --- | --- |
| `providers?: ProviderRegistry \| Readonly<Record<string, ModelProvider>>` | Unified registry or named adapters; defaults to Runtime services when available, otherwise empty |
| `defaultProvider?: string` | Selection: input provider → this option → Runtime config.model.provider → sole registry entry; fail if unresolved |
| `runtime?: { services: RuntimeServices }` | Uses the Runtime provider registry and default provider selection |
| `cache?: InferCacheProvider` | Defaults to an isolated `InMemoryInferCache` |
| `strategies?: Record<string, TrajectoryStrategy>` | Custom strategies; case-sensitive names override built-ins |
| `defaults?: InferSettings` | Replace the Runtime infer defaults object; otherwise inherit Runtime YAML defaults |
| `timeoutMs?: number` | Call deadline: this option, otherwise Runtime config.timeoutMs, otherwise 30,000 ms; integer from 1 to `2^31-1` |

Executors are initialized once per instance; provider resolution observes current registry registrations. Each invocation has its own context, budgets and cancellation signal. Stream queues drain in batches without shifting the remaining array for every event.

`createInferWorker` takes `InferWorkerOptions`: the same fields except `runtime`, provider services come from the execution context. Additional options: `cacheFactory?: () => InferCacheProvider` (called once per replica, overrides `cache`) and `concurrency?: number` (positive integer, unlimited by default). Internal SAMPLE execution stays on the replica without consuming another routing slot; trajectories work with concurrency 1.

## 2. Nodes and calls

| Typed API | Node ID | Input → Output | Streaming |
| --- | --- | --- | --- |
| `reasoning.sample()` | `INFER.REASONING.SAMPLE` | `SampleInput → SampleOutput` | Yes |
| `reasoning.trajectory()` | `INFER.REASONING.TRAJECTORY` | `TrajectoryInput → TrajectoryOutput` | Yes |
| `reasoning.reflect()` | `INFER.REASONING.REFLECT` | `ReflectInput → ReflectOutput` | Yes |
| `reasoning.deliberate()` | `INFER.REASONING.DELIBERATE` | `DeliberateInput → DeliberateOutput` | Yes |
| `cache.lookup()` | `INFER.CACHE.LOOKUP` | `CacheLookupInput → CacheLookupOutput` | No |
| `cache.write()` | `INFER.CACHE.WRITE` | `CacheWriteInput → CacheWriteOutput` | No |
| `cache.invalidate()` | `INFER.CACHE.INVALIDATE` | `CacheInvalidateInput → CacheInvalidateOutput` | No |

Every method returns `Promise<NodeResult<Output>>` and accepts optional `InferCallOptions` as its second argument. Runtime invocation returns that same envelope without another wrapper. Namespaces and strategy names are not routable Nodes.

```ts
import type { SampleInput, SampleOutput } from "@ditto/core/worker/infer";
const result = await infer.execute("INFER.REASONING.SAMPLE", input);
const dynamic = await infer.execute<SampleInput, SampleOutput>(
  "INFER.REASONING.SAMPLE", input,
);
const controller = new AbortController();
const pending = infer.reasoning.sample(input, { signal: controller.signal, timeoutMs: 5_000 });
controller.abort();
console.log((await pending).status); // cancelled
```

### Shared types

```ts
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | unknown[];
  metadata?: Record<string, unknown>;
}
export interface ModelConfig {
  provider?: string;
  model: string;
  endpoint?: string;
  providerOptions?: Record<string, unknown>;
}
export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}
export interface NodeResult<T> {
  executionId: string;
  node: string;
  status: "success" | "failed" | "cancelled" | "timeout";
  output?: T;
  error?: { code: string; message: string };
}
export type ActionTarget =
  | { kind: "tool"; toolName?: string }
  | { kind: "mcp"; server: string; toolName: string }
  | { kind: "node"; node: string };
export interface ActionDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  target?: ActionTarget;
}
export interface ActionRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ContextItem { id?: string; content: unknown; source?: string; score?: number }
export interface MemoryItem { id: string; content: unknown; score?: number; timestamp?: number }
export type Observation = import("@ditto/core").Observation;
export interface ReasoningStep {
  id: string;
  type: "plan" | "model" | "decision" | "action_request" | "observation" | "reflection" | "final";
  index: number;
  parentIds?: string[];
  summary?: string;
  message?: Message;
  actionRequest?: ActionRequest;
  observation?: Observation;
}
export type InferStreamEvent<T> =
  | { type: "start"; executionId: string; node: string }
  | { type: "text_delta"; executionId: string; node: string; delta: string }
  | { type: "step"; executionId: string; node: string; step: ReasoningStep }
  | { type: "result"; executionId: string; node: string; result: NodeResult<T> };
export interface InferCallOptions { signal?: AbortSignal; timeoutMs?: number }
```

Message content arrays are interpreted by the adapter. The OpenAI-compatible adapter sends them as Chat Completions content blocks. Action schemas are objects supplied to the model; the target Worker must validate action arguments against its public contract. Metadata must not carry credentials.

Generation validation: temperature 0–2, topP 0–1, positive integer topK/maxTokens, safe integer seed, and an array of nonempty stop strings. Unspecified values inherit INFER generation defaults, then provider defaults.

## 3. SAMPLE

One call generates one candidate. Configuration is passed to the selected adapter. Use a strategy or multiple Graph calls for multiple candidates.

```ts
export interface SampleInput {
  messages: Message[];
  model: ModelConfig;
  generation?: GenerationConfig;
  actions?: ActionDescriptor[];
  metadata?: Record<string, unknown>;
}
export interface SampleOutput {
  message: Message;
  actionRequests?: ActionRequest[];
  finishReason: "stop" | "length" | "action_request" | "cancelled" | "error";
  usage?: Usage;
}
```

Messages must be nonempty and model.model is required. Action names must be unique. Provider output must contain an assistant message; action_request must have actions and other finish reasons must not have them. Actions must have been declared by the caller. Only caller-owned descriptors bind routing targets; SAMPLE strips provider-supplied routing fields and returns requests without executing them. Observation is the shared Interaction contract, not a second INFER result shape.

A length finish is a successful but truncated sample. Cancelled/error finishes produce cancelled/failed envelopes. Usage counters are nonnegative safe integers; missing usage is not invented.

## 4. TRAJECTORY

```ts
export interface TrajectoryInput {
  messages: Message[];
  objective?: string;
  context?: ContextItem[];
  memory?: MemoryItem[];
  strategy: { name: string; options?: Record<string, unknown> };
  model: ModelConfig;
  generation?: GenerationConfig;
  constraints?: { maxSteps?: number; maxTotalTokens?: number; timeoutMs?: number };
  metadata?: Record<string, unknown>;
}
export interface TrajectoryOutput {
  result: Message;
  steps: ReasoningStep[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_tokens" | "timeout" | "cancelled" | "error";
  usage?: Usage;
}
```

### Strategies

The following are library fallback defaults without configuration. Root `ditto.yaml` sets application defaults (ToT/GoT breadth=2); request fields override them. See the [shared configuration API](configuration.md).

| Name | Options | Implementation |
| --- | --- | --- |
| `cot` | rounds=2, range 1–64 | Linear solution path: concise intermediate solution → final Message in original format; rounds=1 uses one CoT prompt |
| `long-cot` | rounds=4, range 1–64 | More decomposition, computation and checking stages along one linear path |
| `tot` | breadth=3, depth=2, beamWidth=2; each 1–16 | Bounded breadth-first beam search: expand every retained state → rank → retain top beamWidth; select one final candidate at last depth |
| `got` | breadth=3, depth=2; each 1–16 | Bounded layered graph: multiple contributions → multi-parent aggregation → shared state for next layer |
| `self-consistency` | candidates=3, range 1–16 | Independent solutions and deterministic voting on final answers; top ties return NO_CONSENSUS, without another model judge |
| Custom name | Strategy-defined | Injected `TrajectoryStrategy` function |

These are explicit answer drafting/organization procedures. Steps contain public messages and concise decision summaries, not private model reasoning. ToT/GoT implement bounded branch selection/merging rather than a general search engine. Strategies are extensible functions, not additional Nodes.

### Budgets

| Constraint | Default | Meaning |
| --- | --- | --- |
| maxSteps | 16 | Maximum SAMPLE calls, including planning and candidate judging/merging; not steps.length |
| maxTotalTokens | Unlimited | Sum of input/output tokens across samples; every response must report totalTokens or both inputTokens/outputTokens when enabled |
| timeoutMs | No additional limit | Minimum of this deadline and call-level timeout/default Worker timeout |

Remaining tokens cap the next request's generation.maxTokens and block further calls after exhaustion. Input tokens are unknown before the provider returns, so a single request can exceed the total budget; this is not a hard billing cap. Missing accounting produces USAGE_UNAVAILABLE. A length finish stops the trajectory with max_tokens.

Budget stops have outer success and inner partial, preserving the latest result and steps. Model errors have outer failed. Timeout/cancellation have corresponding outer statuses and preserve the trajectory output when execution started. A stopped trajectory without steps has inner failed.

The reasoning path stays Message[] → Message: model/strategy are execution settings, and TRAJECTORY output.result is an assistant Message suitable for the next messages array. Steps, usage and status are execution metadata. parentIds refer only to earlier public steps, exposing linear/tree/aggregation dependencies without exposing private provider reasoning. Deliberation receives the original messages; optional messages on REFLECT/DELIBERATE preserve the original task too.

Without YAML, ToT (breadth=3, depth=2, beamWidth=2) uses 11 SAMPLE calls; default GoT uses 8; voting uses candidates calls. All judging calls consume maxSteps. Voting normalizes JSON key order and whitespace, without inferring semantic equivalence between different prose answers. Strategies organize computation; content correctness requires task-specific acceptance checks. Original methods: [CoT](https://arxiv.org/abs/2201.11903), [ToT](https://arxiv.org/abs/2305.10601), [GoT](https://arxiv.org/abs/2308.09687), [Self-Consistency](https://arxiv.org/abs/2203.11171).

### Graph flows and custom computation strategies

ReAct is a predefined Runtime graph flow, called with `runReactFlow(runtime, input, options?)`; see the [Runtime flow API](../interaction-runtime.md#react-predefined-graph-flow). `react` and `plan-and-act` are no longer TRAJECTORY strategies. For planning, run SAMPLE in an upstream Graph and supply its plan to ReAct. Context/Memory retrieval also belongs to upstream Graphs.

```ts
import type { TrajectoryStrategy } from "@ditto/core/worker/infer";
const refine: TrajectoryStrategy = async ctx => {
  const draft = await ctx.sample(ctx.messages);
  return (await ctx.sample([...ctx.messages, draft.message,
    { role: "user", content: "Check and refine this answer." }])).message;
};
const customInfer = createInfer({ runtime, strategies: { refine } });
```

Strategy context contains only input, assembled messages, signal, sample(messages, trace?), deliberate(candidates, mode, options?), and step(...). It exposes neither act nor invoke. Sampling and deliberation share model budgets. Custom asynchronous work should honor signal; INFER can stop waiting for an uncooperative Promise but cannot forcibly terminate JavaScript.

## 5. REFLECT

```ts
export type ReflectionMode = "critique" | "verify" | "revise";
export interface ReflectInput {
  messages?: Message[];
  target: { result?: Message; trajectory?: ReasoningStep[]; artifact?: unknown };
  mode: ReflectionMode;
  criteria?: Array<{ id: string; description: string; weight?: number }>;
  context?: ContextItem[];
  memory?: MemoryItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface ReflectOutput {
  assessment: { passed?: boolean; summary: string };
  issues: Array<{ severity: "info" | "warning" | "error"; description: string; suggestedFix?: string }>;
  revisedResult?: Message;
  usage?: Usage;
}
```

Target requires result, trajectory, or artifact. Criterion IDs must be unique and weights nonnegative finite numbers. All modes call SAMPLE and validate a JSON object. Critique requires assessment/issues; verify also requires boolean assessment.passed; revise also requires a valid revisedResult.

```ts
const reflected = await infer.reasoning.reflect({
  target: { result: { role: "assistant", content: "Candidate answer" } },
  mode: "verify", criteria: [{ id: "accuracy", description: "Check consistency", weight: 1 }],
  model: input.model,
});
```

Plain JSON or one JSON Markdown code block is accepted. Invalid structure produces INVALID_MODEL_OUTPUT; truncated responses produce INCOMPLETE_MODEL_OUTPUT. There is no automatic retry or speculative parsing fallback. Usage always comes from the provider, never model-generated JSON.

## 6. DELIBERATE

```ts
export interface DeliberateInput {
  messages?: Message[];
  selectCount?: number;
  objective?: string;
  candidates: Array<{ id: string; result: Message; trajectory?: ReasoningStep[]; score?: number }>;
  mode?: "select" | "merge" | "consensus" | "debate";
  context?: ContextItem[];
  model: ModelConfig;
  generation?: GenerationConfig;
  metadata?: Record<string, unknown>;
}
export interface DeliberateOutput {
  result: Message;
  selectedCandidateIds?: string[];
  assessments?: Array<{ candidateId: string; score?: number; accepted?: boolean; summary?: string }>;
  decisionSummary?: string;
  usage?: Usage;
}
```

Candidates must be nonempty with unique IDs. Select defaults to one candidate, with selectCount controlling the retained count; merge combines complementary content; consensus reconciles agreement and uncertainty; debate compares objections and resolves differences. Each mode makes one SAMPLE call; debate does not imply an autonomous multi-agent debate loop.

```ts
const decision = await infer.reasoning.deliberate({
  candidates: [
    { id: "a", result: { role: "assistant", content: "Plan A" } },
    { id: "b", result: { role: "assistant", content: "Plan B" } },
  ], mode: "select", objective: "Minimize implementation effort", model: input.model,
});
```

Selected/assessed IDs must refer to supplied candidates and cannot repeat. Select requires exactly selectCount IDs (default 1), ordered best first, and returns the first candidate's original Message, preventing unrequested rewriting. Other modes return the synthesized Message. JSON completeness/structure validation matches REFLECT. No additional REFLECT call is made.

Defaults are configurable under `workers.infer.deliberate` in root `ditto.yaml`: `mode: select`, `selectCount: 1`, and `generation.maxTokens: 4096`. Omitted request fields inherit those defaults; request values override them. Node-specific generation overrides common INFER generation. Configured selectCount only applies to select mode; a count exceeding the candidate count fails before calling the provider. ToT/GoT retain their explicit modes and trajectory budgets. See the [configuration API](configuration.md).

## 7. CACHE

Caching is explicit: no automatic request caching or key generation, and no long-term Memory access. Include model, generation, actions, input digest and relevant data versions in application-generated keys.

```ts
export interface InferCacheKey {
  namespace?: string;
  scope: "sample" | "trajectory" | "reflection" | "deliberation" | string;
  key: string;
}
```

```ts
export interface CacheLookupInput { key: InferCacheKey }
export interface CacheLookupOutput { hit: boolean; value?: unknown }
```

```ts
export interface CacheWriteInput { key: InferCacheKey; value: unknown; ttlMs?: number; tags?: string[] }
export interface CacheWriteOutput { written: boolean; key: InferCacheKey }
```

```ts
export interface CacheInvalidateInput {
  selector: { type: "key"; key: InferCacheKey } | { type: "tag"; tag: string } | { type: "namespace"; namespace: string };
}
export interface CacheInvalidateOutput { invalidated: number }
```

```ts
const key = { namespace: "tenant-a", scope: "sample", key: "input-version-42" };
await infer.cache.write({ key, value: direct.output, ttlMs: 60_000, tags: ["model-v1"] });
const cached = await infer.cache.lookup({ key });
await infer.cache.invalidate({ selector: { type: "tag", tag: "model-v1" } });
// Also: { type: "key", key } or { type: "namespace", namespace: "tenant-a" }
```

The default cache uses a collision-safe tuple `(namespace ?? "", scope, key)` with nonempty scope/key. Omitted and empty namespace are equivalent. Omitted TTL means no expiration; zero means immediate expiration; negative/noninteger TTL is rejected. Writes and reads use structuredClone to isolate mutations; local undefined values can still be hits. The default maximum is 1,000 entries (constructor maxEntries), evicted in LRU order. Reads/key invalidations check only the target entry. Expired entries are also swept under capacity pressure and during tag/namespace invalidation; no timer is used. Overwriting replaces old tags. Tag invalidation is exact and spans namespaces; invalidated counts only live deleted entries.

The default backend is neither persistent nor shared between replicas. Inject InferCacheProvider for shared/durable semantics. Remote calls follow existing JSON/Artifact transport restrictions; functions, cycles and undefined do not retain arbitrary local semantics. Custom backends own consistency and persistence guarantees.

## 8. Streaming

```ts
for await (const event of infer.reasoning.trajectory.stream({
  ...input, strategy: { name: "cot" },
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "step") console.log(event.step.type, event.step.index);
  if (event.type === "result") console.log(event.result.status, event.result.output);
}
```

Each iterator yields start, zero or more text_delta/step events, then exactly one result. Events share the top-level executionId and node. Breaking iteration aborts execution and the consumer receives no later terminal event. Native adapter streams forward real deltas; invoke-only adapters emit one complete text delta after completion.

Trajectory deltas include intermediate candidates, judging JSON and final answers; read result.output.result for the final answer instead of concatenating deltas. Reflection/deliberation deltas are unparsed JSON; read structured output from the terminal event. CACHE has no stream methods. Existing HTTP transport returns complete NodeResult objects without SSE streaming. Use the local SDK on the model execution process for streaming.

## 9. Providers and cache backends

Models use the unified `ModelProvider.invoke/stream` interface and `ProviderRegistry`, shared by Runtime and INFER. Built-in protocols cover OpenAI-compatible, Anthropic and Gemini. See the [Provider API](providers.md) for construction, registration, field mapping, streaming and tool round trips. The former `ModelProviderAdapter.sample` and separate `models` option have been removed.

```ts
interface InferCacheProvider {
  lookup(input: CacheLookupInput): Promise<CacheLookupOutput>;
  write(input: CacheWriteInput): Promise<CacheWriteOutput>;
  invalidate(input: CacheInvalidateInput): Promise<CacheInvalidateOutput>;
}
```

The Node validates inputs and deadlines; the backend implements storage semantics.

Trace accepts optional parentIds/summary; sample and deliberate return an additional stepId, and step returns the complete ReasoningStep. Deliberate options accept selectCount for select mode.

## 10. Errors and verification

| Code | Meaning |
| --- | --- |
| INVALID_INPUT | Invalid input structure, enum, range or call options |
| UNKNOWN_NODE / UNKNOWN_STRATEGY | Unsupported node / strategy |
| PROVIDER_NOT_FOUND | Missing or unresolved adapter |
| INVALID_MODEL_OUTPUT | Invalid message, action, usage or structured JSON |
| INCOMPLETE_MODEL_OUTPUT | Truncated structured output / incomplete SSE |
| UNDECLARED_ACTION | SAMPLE requested an undeclared action |
| USAGE_UNAVAILABLE | Token budget enabled without sufficient provider accounting |
| ENDPOINT_MISMATCH / PROVIDER_HTTP_ERROR | Endpoint differs / unsuccessful HTTP response |
| MODEL_ERROR | Explicit provider error finish, including content_filter |
| TIMEOUT / CANCELLED | Deadline expired / execution cancelled |
| EXECUTION_FAILED | Other exceptions, such as adapter errors, denied Sandbox permissions or uncloneable cache values |

Node errors become NodeResult envelopes. Construction errors throw directly. Pre-dispatch Runtime/transport errors (no Worker, closed Runtime, HTTP authentication) keep existing exception semantics.

Run npm run check. INFER coverage lives in test/infer.test.ts, test/infer-provider.test.ts and test/infer.type-test.ts. Tests use injected model responses and real localhost Worker HTTP transport; they do not need a live model or API key.
