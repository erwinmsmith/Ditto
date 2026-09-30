# INFER Worker API

**English** · [简体中文](infer.zh-CN.md) · [API index](README.md)

This reference describes the implementation in `src/worker/infer/`: model sampling, explicit reasoning trajectories, reflection, candidate deliberation, and inference caching. Graphs supply Context and Memory upfront. ReAct and other cross-Worker orchestration belong to Runtime graph flows. INFER does not execute tools, MCP, or shells.

Import INFER contracts from `@codesoul-co/ditto/worker/infer` or the root `Infer` type namespace. Graph bindings map Context/Memory outputs to INFER fields.

## Functional selection and parameter effects

### Choose a Node by task

The table uses full Node IDs; short names such as SAMPLE are explanatory. The four REASONING Nodes generate content through providers; the three CACHE Nodes operate only on explicit cache entries.

| Node | Suitable tasks | Behavior controls | Execution and Worker impact |
| --- | --- | --- | --- |
| `INFER.REASONING.SAMPLE` | Answers, classification, extraction, plans, text or action requests | `messages`, `model`, `generation`, `actions` | Generates one response. Built-in OpenAI-compatible and Gemini adapters enforce one candidate. INTERACTION executes requested actions separately |
| `INFER.REASONING.TRAJECTORY` | Advance stages within one reasoning task, explore alternative solutions or vote on independent answers | `strategy`, `constraints`, `objective`, `context`, `memory` | One Node call can make several model requests, sharing its budget, deadline and Worker entry slot |
| `INFER.REASONING.REFLECT` | Review an existing answer, plan, trajectory or artifact; propose a revision | `target`, `mode`, `criteria`, reference data | One model review parsed into a structured assessment; critical facts and permissions still need deterministic checks |
| `INFER.REASONING.DELIBERATE` | Rank, select or combine existing candidates; organize disagreements | `candidates`, original task, `mode`, `selectCount` | One model deliberation; does not generate candidates. In select mode, `result` is the first-ranked original candidate; retained IDs appear in `selectedCandidateIds` |
| `INFER.CACHE.LOOKUP` | Check for a reusable result before generating | `key.namespace`, `key.scope`, `key.key` | Returns an existing value on a hit or `hit:false`; a miss does not automatically call SAMPLE |
| `INFER.CACHE.WRITE` | Save a validated inference result for reuse | `value`, `key`, `ttlMs`, `tags` | Writes the cache backend; does not write MEMORY or automatically cache other Node results |
| `INFER.CACHE.INVALIDATE` | Remove old results after data, prompts or models change | A key, tag or namespace `selector` | Invalidates an exact entry or a group; broader invalidation can cause more subsequent misses and model calls |

### Generation: stability, diversity and output budgets

These parameters affect model decoding. They neither change SAMPLE's candidate count nor grant tool permissions. Ranges below are Ditto validation ranges; a model may support only a subset.

| Parameter | Behavioral effect | Tradeoff and boundary |
| --- | --- | --- |
| `temperature`, 0–2 | On supporting models, lower values generally concentrate output; higher values increase sampling randomness and can produce different wording or approaches | Higher settings can also increase deviations from required formats or evidence. They are not confidence values and do not guarantee broader correct-answer coverage. Zero does not guarantee identical text |
| `topP`, 0–1 | Limits possible tokens by cumulative probability mass; lower settings usually narrow the choices, higher settings admit more low-probability options | Interacts with temperature. Change one primary sampling control at a time so the cause of a difference remains clear |
| `topK`, positive integer | On supporting models, restricts selection to the K most probable tokens; smaller K narrows choices | Not a retrieval result count and does not add facts. The OpenAI-compatible adapter sends `top_k`, which an endpoint may reject; Gemini support also depends on the model |
| `maxTokens`, positive integer | Caps one generation's output budget; larger limits accommodate longer answers, JSON or revisions | Does not require using the entire budget or enlarge the input window. Small limits can produce `finishReason:"length"`; some models count internal reasoning toward the output budget |
| `stop`, nonempty string array | Ends generation when a configured sequence appears | Useful for delimiters but can truncate JSON or prose. `finishReason:"stop"` does not replace completeness and format validation |
| `seed`, safe integer | Supplies a sampling seed for repeated experiments where supported | Model version, endpoint and other settings still matter; deterministic output is not guaranteed. The built-in Anthropic adapter explicitly rejects `generation.seed` |

Consult [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) and [Gemini GenerationConfig](https://ai.google.dev/api/generate-content#generationconfig) for sampling semantics and model support. Check the specific model before applying a temperature profile. Ditto does not universally fill an omitted temperature with 1; Worker defaults and adapter/model defaults apply separately.

### Input design also changes the result

| Parameter | Node impact | Downstream impact |
| --- | --- | --- |
| `messages` roles, order and content | Establish the task, constraints, evidence and history; longer input generally increases input tokens and processing load | Identify untrusted evidence and specify the output structure. Temperature cannot compensate for missing facts or external text promoted into high-priority instructions |
| `model.provider` / `model.model` | Select a registered adapter and model; model capabilities and native multimodal formats determine supported inputs | Can change cost, latency, context windows and action support. Re-evaluate the same tasks and validation after changing models |
| `model.providerOptions` | Supplies provider-specific adapter fields | Does not make them portable. Core request fields and explicit generation settings can override corresponding values; `n` cannot bypass the single-candidate contract |
| SAMPLE `actions[].description` / `inputSchema` | Helps the model choose actions and construct arguments | Descriptors define the model-visible protocol; tool validators still check arguments. SAMPLE checks declared action names and the trusted caller binds targets |
| `metadata` | Provides call metadata whose use depends on the adapter | Built-in HTTP protocols do not automatically send top-level metadata as a prompt or request metadata. Put model-visible information in explicit message fields |
| REFLECT `criteria`, `target` / DELIBERATE `objective`, `messages` | Defines review criteria and the original task so comparison remains relevant | Criteria weights and candidate scores are model input data, not a deterministic weighted total computed by the framework |

### Multi-step reasoning: controls that increase actual model calls

The table describes built-in strategies without errors or early budget stops. Their candidate calls currently run sequentially; raising Worker concurrency does not parallelize a loop inside one TRAJECTORY.

| Strategy / parameter | Default | Effect of increasing it |
| --- | --- | --- |
| `cot.options.rounds` / `long-cot.options.rounds` | 2 / 4; range 1–64 | One model request per round, with earlier results carried forward. History and accumulated latency grow; correctness is not guaranteed to improve |
| `self-consistency.options.candidates` | 3; range 1–16 | Generates that many independent answers and uses deterministic answer voting. No extra model judge; a tie for the highest vote fails |
| `tot.options.breadth` / `depth` / `beamWidth` | 3 / 2 / 2; each 1–16 | Breadth adds alternatives per retained state, depth adds levels, beamWidth retains more states for later expansion. Each level also needs one model ranking call |
| `got.options.breadth` / `depth` | 3 / 2; each 1–16 | Each level generates breadth perspectives and makes one model merge call: `depth * (breadth + 1)` requests |
| `constraints.maxSteps` | 16; positive integer | Bounds actual model requests in this TRAJECTORY, including ranking/merging. It is neither `steps.length` nor the Loop's Graph count |
| `constraints.maxTotalTokens` | Unset | Bounds cumulative input/output usage, requiring usable usage from every provider call. A smaller budget can yield partial output; large input can still make final usage exceed the limit |
| `constraints.timeoutMs` | Inherited, also bounded by the call deadline | Increases available time only when other effective deadlines allow it; a larger budget does not restart a stopped call |

For example, ToT breadth=3, depth=2, beamWidth=2 needs `3 + 1 + 2*3 + 1 = 11` model requests, including two rankings. `maxSteps:4` cannot complete that path; temperature does not change the request count. To generate candidates concurrently, place several SAMPLE branches in a Graph and then invoke DELIBERATE; see [candidate workflows](candidate-workflows.md).

REFLECT critique identifies issues, verify requires a pass/fail assessment, and revise requires a revised result; one call does not repeatedly review itself. DELIBERATE select retains original candidates, merge generates a combined answer, consensus organizes agreement and uncertainty, and debate compares objections. These modes do not automatically start other Agents. Loop controls repeated review and stopping.

### Worker defaults, caching and resource usage

Ordinary generation fields resolve as request `generation` field → effective Worker generation default field → adapter/model default. DELIBERATE additionally overlays `defaults.deliberate.generation` on ordinary defaults before request fields. Explicit `createInferWorker({defaults})` replaces the Runtime infer defaults object rather than automatically deep-merging YAML; include every group you intend to retain.

Request parameters do not mutate replica configuration. Worker concurrency limits simultaneous Node entry calls. One long trajectory holds one slot while potentially making many model requests. More slots can improve independent-task throughput but may hit provider rate limits. Standalone SDK calls bypass Runtime replica scheduling. Timeouts bound waiting and cooperative cancellation; custom providers must honor the signal to stop underlying I/O.

The default memory inference cache holds at most 1000 entries, isolated per SDK/replica. For this backend, omitted `ttlMs` has no expiry but remains subject to LRU eviction; zero removes the old value without retaining the new one. Longer TTL increases reuse and the lifetime of stale information. Application keys should bind model, generation settings, prompt version and evidence version; different requests sharing a key can return an old result. Reusing one cached value also prevents new diversity even with a higher temperature.

### Evaluate settings by scenario

Start with model-recommended defaults. Where the model supports temperature tuning, the following are experimental starting points rather than Ditto defaults or quality guarantees.

| Scenario | Design to try | What to check |
| --- | --- | --- |
| Classification, extraction, tool arguments, supervisor decisions | Low temperature, for example 0–0.2; explicit structure; enough output budget | Schema, business constraints, tool permissions, errors and truncation. Low temperature does not guarantee factual accuracy |
| Copywriting and solution exploration | Higher temperature, for example 0.7–1; distinct perspectives; several SAMPLE branches | Candidate differences, goal coverage and feasibility, followed by lower-temperature deliberation. One random response does not cover several solutions |
| Evidence-based factual answers | Provide evidence through CONTEXT/retrieval and require checked citations | Agreement with sources and evidence gaps. Raising temperature does not expand retrieval |
| Long reasoning or revision | Set model-call, cumulative token, timeout and Loop limits together | Outer/inner status, stopReason, actual usage and task completion |

## 1. Setup and lifecycle

```ts
import { createDitto, createInfer, createInferWorker,
  createHttpProvider } from "@codesoul-co/ditto";

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
import type { SampleInput, SampleOutput } from "@codesoul-co/ditto/worker/infer";
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
export type Observation = import("@codesoul-co/ditto").Observation;
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

ReAct is a predefined Runtime graph flow, called with `runReactFlow(runtime, input, options?)`; see the [Runtime flow API](../interaction-runtime.md#react-predefined-graph-flow). For planning, run SAMPLE in an upstream Graph and supply its plan to ReAct. Context/Memory retrieval also belongs to upstream Graphs.

```ts
import type { TrajectoryStrategy } from "@codesoul-co/ditto/worker/infer";
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

Models use the unified `ModelProvider.invoke/stream` interface and `ProviderRegistry`, shared by Runtime and INFER. Built-in protocols cover OpenAI-compatible, Anthropic and Gemini. See the [Provider API](providers.md) for construction, registration, field mapping, streaming and tool round trips.

```ts
interface InferCacheProvider {
  lookup(input: CacheLookupInput, options?: InferCacheCallOptions): Promise<CacheLookupOutput>;
  write(input: CacheWriteInput, options?: InferCacheCallOptions): Promise<CacheWriteOutput>;
  invalidate(input: CacheInvalidateInput, options?: InferCacheCallOptions): Promise<CacheInvalidateOutput>;
}
```

The Node validates inputs and deadlines; the backend implements storage semantics.

Trace accepts optional parentIds/summary; sample and deliberate return an additional stepId, and step returns the complete ReasoningStep. Deliberate options accept selectCount for select mode.

## 10. Errors

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

## Examples for each API

Complete source: [examples/infer.ts](examples/infer.ts). The functions below share its imports; importing the file executes no examples. Applications supply database, model, or MCP resources. Choose the function you need; writes, deletes, and model calls perform real operations when invoked.

```ts
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto";
import {
  createInfer, createInferWorker, InMemoryInferCache, inferSampleNode,
  type InferClient, type ModelConfig, type TrajectoryInput, type ReflectInput,
  type DeliberateInput, type TrajectoryStrategy, type InferCacheProvider, type ModelProvider, type SampleInput,
} from "@codesoul-co/ditto/worker/infer";

import { ProviderRegistry, createHttpProvider, type HttpProviderOptions } from "@codesoul-co/ditto/worker/infer/providers";
```

Import INFER types from `@codesoul-co/ditto/worker/infer` to avoid confusing them with Core Message / MemoryItem. INFER content is text or Provider content arrays; Interaction allows broader JSON content.

### createInfer / createInferWorker: configuration and cache

The SDK reuses Runtime services. Sharing cache requires injecting the same backend, and neither API automatically caches model output. Worker cacheFactory creates per-replica caches and takes precedence over cache.

```ts
export function setupInfer() {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const cache = new InMemoryInferCache({ maxEntries: 2_000 });
  const runtime = createDitto({ config, workers: [createInferWorker({ cache, concurrency: 4 })] });
  const infer = createInfer({ runtime, cache });
  return { runtime, infer }; // runtime.close() drains Workers; the application owns external clients.
}
```

### reasoning.sample / SAMPLE: messages

Returns an assistant Message, finishReason, and optional usage. Inspect actual results; finishReason=length indicates truncation.

```ts
export async function sample(infer: InferClient, model: ModelConfig) {
  const result = await infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Return the sum of 17 and 25." }],
    generation: { temperature: 0, maxTokens: 256 },
  });
  if (result.status !== "success" || !result.output) throw new Error(result.error?.code ?? result.status);
  return { message: result.output.message, finishReason: result.output.finishReason, usage: result.output.usage };
}
```

### SAMPLE actions: action requests

Actions describe available operations; actionRequests are returned for Graph/ReAct execution. The application binds targets; SAMPLE executes no tools.

```ts
export async function sampleActions(infer: InferClient, model: ModelConfig) {
  return infer.reasoning.sample({ model,
    messages: [{ role: "user", content: "Read README.md using the available tool." }],
    actions: [{ name: "read_text", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      target: { kind: "tool", toolName: "read_text" } }],
  }); // Inspect output.actionRequests; SAMPLE does not execute them.
}
```

### reasoning.trajectory / TRAJECTORY: completion

Check both NodeResult.status and output.status. Outer success can contain a partial trajectory after budget exhaustion.

```ts
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
```

### CoT, Long CoT, ToT, GoT, self-consistency examples

Each request selects one built-in trajectory strategy. For example, call `await infer.reasoning.trajectory(strategyRequests(model)[0]!)`. Strategies do not require separate Workers.

```ts
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
```

### reasoning.reflect / REFLECT: three modes

Call reflectModes with critique, verify, or revise. All return assessment/issues; verify requires passed and revise requires revisedResult. Invalid generated JSON fails validation.

```ts
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
```

### reasoning.deliberate / DELIBERATE: four modes

Pass select, merge, consensus, or debate. selectCount is valid only for select and cannot exceed the candidate count. select returns the original top candidate Message; other modes synthesize one.

```ts
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
```

### cache.write / lookup / invalidate: all cache operations

Includes all three methods and key/tag/namespace invalidation. hit=false is a successful miss; check NodeResult.status first. Tag invalidation spans namespaces.

```ts
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
```

### infer.execute: generic dispatch

Returns the same NodeResult as typed convenience methods and supports only the seven INFER leaves. Explicit Input/Output generics do not bypass runtime validation.

```ts
export async function executeInfer(infer: InferClient, model: ModelConfig) {
  return infer.execute("INFER.REASONING.SAMPLE", { model, messages: [{ role: "user", content: "Hello" }] }, { timeoutMs: 5_000 });
}
```

### sample.stream / trajectory.stream / reflect.stream / deliberate.stream

Each streaming method has an example and its terminal output field. All accept `{ signal, timeoutMs }`. This comparison consumes four streams sequentially; applications usually select one. text_delta is not the final structured result.

```ts
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
```

### InferCallOptions: cancellation and deadlines

A pre-aborted signal returns cancelled without starting a model request. Use controller.abort() for in-flight cancellation; stopping SDK waiting does not imply rollback by the service.

```ts
export async function cancelInfer(infer: InferClient, model: ModelConfig) {
  const controller = new AbortController();
  controller.abort();
  return infer.reasoning.sample({ model, messages: [{ role: "user", content: "Hello" }] }, { signal: controller.signal, timeoutMs: 5_000 });
}
```

### InMemoryInferCache / InferCacheProvider raw API

Options are `{ maxEntries?: number, now?: () => number }`, defaulting to 1000 entries and Date.now. now supplies a millisecond clock. Raw methods return raw outputs; SDK/Worker add input validation, deadlines, and NodeResult.

```ts
export async function cacheProviderApi(cache: InferCacheProvider = new InMemoryInferCache({ maxEntries: 100 })) {
  const key = { scope: "sample", key: "example" };
  await cache.write({ key, value: "cached message", ttlMs: 1_000 });
  const hit = await cache.lookup({ key }); // Raw CacheLookupOutput, not NodeResult.
  const invalidated = await cache.invalidate({ selector: { type: "key", key } });
  return { hit, invalidated };
}
```

### TrajectoryStrategy: sample / deliberate / step

Covers all three computation methods and signal. sample/deliberate return stepId for parentIds. step records public trace only. Computation consumes the current trajectory budget and does not schedule tools or other Workers.

```ts
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
```

### Node descriptor type / define

`inferSampleNode`, `inferTrajectoryNode`, `inferReflectNode`, and `inferDeliberateNode` expose `.type` and `.define(workerType, handler)`. Normally use createInferWorker. This example binds an SDK method as one NodeDefinition. Cache leaves are registered by the factory; INFER_CACHE_NAMESPACE is only the string INFER.CACHE and cannot be invoked.

```ts
export function sampleDescriptor(infer: InferClient) {
  return inferSampleNode.define("INFER", input => infer.reasoning.sample(input));
}
```

## Compose with CONTEXT

Select with CONTEXT.SELECT and explicitly map to messages. Working ContextItem.source is a Reference; INFER context source uses its URI string. [Complete CONTEXT API and examples](context.md)。

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

[Complete imports and source](examples/context.ts).

## Runtime cancellation

Cancellation from `runtime.invoke(node, input, { signal })` and `runtime.run(graph, input, { signal })` flows through the built-in INFER Worker into its executor and model provider, matching direct SDK behavior. Providers should use their HTTP/SDK cancellation mechanism. For example:

```ts
await runtime.invoke("INFER.REASONING.SAMPLE", {
  model: { provider: "openai", model: "configured-model" },
  messages: [{ role: "user", content: "Explain caching" }],
}, { signal: AbortSignal.timeout(5000) });
```

HTTP and IPC cancellation currently stops the caller's wait without automatically interrupting remote execution. Configure model deadlines on the serving Worker as well.

External `InferCacheProvider.lookup/write/invalidate(input, options?)` methods accept `InferCacheCallOptions { signal?: AbortSignal }` second. For example, `lookup: (input, options) => databaseCache.lookup(input, options)` forwards cancellation to a compatible adapter; map it to the underlying SDK as needed. INFER timeouts stop waiting but do not undo committed cache writes.

[Content processing workflows](content-workflows.md) compose SAMPLE generation and independent review with Redis Context, database Memory and validated artifact publication.
