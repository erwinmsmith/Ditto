# Shared configuration API

[简体中文](configuration.zh-CN.md) · [Worker API](README.md)

The root [`ditto.yaml`](../../ditto.yaml) contains versioned behavior defaults. [`.env.example`](../../.env.example) is the deployment template; actual `.env` credentials are ignored by Git. Load environment variables with Node `--env-file=.env`, then explicitly load YAML once at application startup. Importing the library or creating an unconfigured Runtime reads neither files nor environment variables.

```ts
import { createDitto, createInfer, createInferWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the default model in .env");
const runtime = createDitto({ config, workers: [createInferWorker()] });
try {
  const infer = createInfer({ runtime });
  const result = await infer.reasoning.trajectory({
    model: config.model,
    messages: [{ role: "user", content: "Compute 17 * 23. Return only the integer." }],
    strategy: { name: "tot" }, // breadth, depth and beamWidth come from YAML
  });
  console.log(result);
} finally { await runtime.close(); }
```

## Groups

```yaml
runtime:               # Timeouts and Graph orchestration
  timeoutMs: 120000
  maxTurns: 8
  graphConcurrency: 8
  loopMaxIterations: 32
  react: {}
shared:
  providers: {}        # Shared provider behavior
workers:
  memory:
    queryLimit: 100
    searchLimit: 10
  infer:               # INFER-specific defaults
    generation: {}
    constraints: {}
    strategies: {}
    deliberate: { mode: select, selectCount: 1, generation: { maxTokens: 4096 } }
```

Environment variables use matching ownership prefixes with comment sections:

| Owner | Prefix |
| --- | --- |
| Runtime | DITTO_RUNTIME_* |
| Shared providers | DITTO_SHARED_PROVIDERS, DITTO_SHARED_PROVIDER_<NAME>_* |
| Shared permissions | DITTO_SHARED_SANDBOX_ALLOW_* |
| INFER Worker | DITTO_WORKER_INFER_* |
| HTTP transport | DITTO_TRANSPORT_HTTP_* |

INFER, MEMORY and optional RETRIEVAL consume Worker-specific settings; database connections remain owned by external plugins. The transport token is read explicitly by HTTP bootstrap code and stays out of YAML and inference requests.

## Ownership and loaders

| Source | Settings |
| --- | --- |
| `.env` | DITTO_RUNTIME_ENV, DITTO_RUNTIME_WORKSPACE; enabled DITTO_SHARED_PROVIDERS; paired DITTO_WORKER_INFER_MODEL_PROVIDER/DITTO_WORKER_INFER_MODEL; per-provider DITTO_SHARED_PROVIDER_<NAME>_KIND/BASE_URL/API_KEY/MODEL; DITTO_SHARED_SANDBOX_ALLOW_NETWORK/TOOLS/MCP/SKILLS/READ/WRITE/EXECUTE permissions; explicit HTTP Worker bootstrap token |
| `ditto.yaml` | Runtime timeout and ReAct turns, INFER generation/trajectory budgets/strategy parameters, ReAct action budget, provider request behavior, MEMORY query/search limits |
| Node input | Messages, model, candidates, criteria and optional per-request overrides |

```ts
loadRuntimeConfigFile(path = "ditto.yaml", env = process.env): RuntimeConfig
loadRuntimeConfig(env = process.env, settings: RuntimeSettings = {}): RuntimeConfig
```

The file loader reads UTF-8 YAML relative to the current working directory. The second loader takes an object without file access. Both loaders return a normalized immutable snapshot containing environment, workspace, model, providers, timeoutMs, maxTurns, graphConcurrency, loopMaxIterations, infer, context, interaction, memory, retrieval, react, sandbox and sandboxExecution. Workers access it through ctx.services.config and may receive independent services at registration. Reload and recreate the Runtime after editing YAML; there is no per-call file I/O or hot reload.

Missing/empty files, non-object roots, unknown keys, duplicate keys, aliases and invalid values fail at startup. YAML does not interpolate environment variables or accept deployment fields such as apiKey/baseUrl. Provider options are request parameters, never a place for credentials. Custom createDitto({ providers }) skips HTTP provider construction from config.

For embedded use without file or environment reads, the second argument accepts the same RuntimeSettings shape as YAML. Root YAML remains the recommended shared application configuration.

```ts
import { createDitto, loadRuntimeConfig } from "@ditto/core/runtime";

const config = loadRuntimeConfig({}, {
  runtime: { timeoutMs: 15_000, graphConcurrency: 2, loopMaxIterations: 4 },
  workers: { memory: { queryLimit: 20, searchLimit: 5 } },
});
const runtime = createDitto({ config });
try { console.log(runtime.services.config.graphConcurrency); }
finally { await runtime.close(); }
```

## YAML fields

All fields are optional. Request values take precedence over configuration, then library fallback defaults.

| Path | Meaning / validation | Library fallback / checked-in YAML |
| --- | --- | --- |
| runtime.timeoutMs | INFER/ReAct deadline, integer 1–2147483647 ms | 30000 / 120000 |
| runtime.maxTurns | ReAct default turns, positive safe integer | 8 / 8 |
| `runtime.graphConcurrency` | Positive integer parallel node limit per graph; run/loop options override | Unlimited / 8 |
| `runtime.loopMaxIterations` | Positive integer generic Loop limit; definition.maxIterations overrides | 32 / 32 |
| workers.infer.generation.maxTokens | Per-generation token limit, positive safe integer | Provider default / 4096 |
| workers.infer.generation.temperature/topP/topK/stop/seed | [GenerationConfig](infer.md): 0–2 / 0–1 / positive integer / nonempty strings / safe integer | Unspecified |
| workers.infer.constraints.maxSteps | Total model calls per trajectory, including ranking/merging, positive safe integer | 16 / 16 |
| workers.infer.constraints.maxTotalTokens | Total trajectory tokens, positive safe integer; requires provider usage | Unlimited / 64000 |
| workers.infer.constraints.timeoutMs | Additional trajectory deadline, same range as runtime.timeoutMs | Unspecified |
| workers.infer.strategies.cot.rounds | Linear solution rounds, 1–64 | 2 / 2 |
| workers.infer.strategies.long-cot.rounds | Extended linear solution rounds, 1–64 | 4 / 4 |
| workers.infer.strategies.tot.breadth/depth/beamWidth | Branches per parent / depth / retained frontier width, each 1–16 | 3/2/2 / 2/2/2 |
| workers.infer.strategies.got.breadth/depth | Contributions per layer / aggregation layers, each 1–16 | 3/2 / 2/2 |
| workers.infer.strategies.self-consistency.candidates | Independent samples, 1–16 | 3 / 3 |
| workers.infer.deliberate.mode | Default DELIBERATE mode: select / merge / consensus / debate | select / select |
| workers.infer.deliberate.selectCount | Number retained in select mode, positive safe integer; cannot exceed the request candidate count | 1 / 1 |
| workers.infer.deliberate.generation | Node-specific GenerationConfig, overrides shared INFER generation defaults | Inherit / maxTokens=4096 |
| runtime.react.maxActionCalls | Maximum ReAct actions, nonnegative safe integer | 16 / 16 |
| runtime.react.maxTotalTokens | Total ReAct sampling tokens, positive safe integer | Unlimited / 64000 |
| shared.providers.<name>.maxTokensField | max_tokens or max_completion_tokens; OpenAI-compatible only | Adapter uses max_completion_tokens when omitted |
| shared.providers.<name>.options | Native provider request object, e.g. thinking settings | Empty |

Provider names in YAML configure behavior without enabling providers. DITTO_SHARED_PROVIDERS selects the active names; inactive YAML entries can remain as shared templates.

## Overrides and budgets

Generation, constraints and the selected strategy's options merge by field without mutating caller input. Setting only strategy.options.depth keeps the configured breadth/beamWidth. Nested SAMPLE calls from REFLECT and DELIBERATE inherit generation defaults too.

createInfer({ runtime }) and the Runtime Worker share these defaults. InferOptions.defaults?: InferSettings supports a standalone SDK or a Worker override: when supplied, it **replaces the entire Runtime infer defaults object**; when omitted, defaults come from Runtime. Custom strategies remain registered as functions using strategies, with custom options supplied in each request.

Call timeoutMs overrides the SDK/Worker option, then Runtime timeout. Effective trajectory timeout is the minimum of that value and constraints.timeoutMs; request constraints can override their YAML defaults. Nested generation is capped by both maxTokens and the remaining total-token budget. Increasing depth can exhaust maxSteps or maxTotalTokens and return partial with an explicit stopReason. The checked-in ToT settings use 8 model calls; GoT uses 6.

runReactFlow remains a Runtime graph preset. It uses runtime.maxTurns, react budgets and workers.infer.generation, independently of trajectory strategy settings.

DELIBERATE resolves mode and selectCount from the request, then workers.infer.deliberate, then library defaults (select / 1). Configured selectCount only applies when the effective mode is select; supplying selectCount explicitly for other modes is invalid. Counts larger than the available candidates fail before a provider call. Generation precedence is request > deliberate.generation > infer.generation > provider defaults. ToT explicitly supplies selection mode and retention count; GoT explicitly supplies merge mode. Their judging calls inherit DELIBERATE generation defaults and remain capped by the trajectory's remaining token budget; explicit trajectory generation overrides the node defaults.

## MEMORY

`workers.memory.queryLimit` / `searchLimit` are integers in 1–10000, defaulting to 100 / 10 in both Core and root YAML, normalized as `config.memory`. Per-field precedence: request limit > MemoryOptions.defaults > Runtime YAML > built-in defaults. Standalone SDKs opt in with `defaults: config.memory`. External plugins own database env parsing; Core parses no database connections or credentials. See [MEMORY API](memory.md).

## RETRIEVAL (optional)

`workers.retrieval.searchLimit` is an integer in 1–10000, defaulting to 10 and normalized as config.retrieval. Precedence: request limit > options.defaults.searchLimit > Runtime YAML > built-in default. YAML does not install/register/start a Worker; the application must explicitly import the optional entry and call createRetrievalWorker. Application providers own connections, credentials and model handles; no database env placeholders are added. See [RETRIEVAL API](retrieval.md).

## CONTEXT

`workers.context` is parsed into `config.context` at startup. Pass it explicitly to SDK/Worker construction; loading config does not connect Redis.

```yaml
workers:
  context:
    policy:
      maxInlineBytes: 65536
      maxItems: 256
      duplicate: replace
      missingRemoval: ignore
    cache:
      ttlMs: 3600000
      keyPrefix: "ditto:context:"
```

| Field | Default | Values |
| --- | --- | --- |
| policy.maxInlineBytes | 65536 | 1..1000000 |
| policy.maxItems | 256 | 1..1000000 |
| policy.maxTokens | unset | 1..1000000 |
| policy.duplicate | replace | replace / keep-first / reject |
| policy.missingRemoval | ignore | ignore / reject |
| cache.ttlMs | 3600000 | 1..2147483647 |
| cache.keyPrefix | ditto:context: | Nonempty string |

Store the Redis URL/credentials in `.env` as `DITTO_WORKER_CONTEXT_REDIS_URL` for the application SDK; behavior belongs in YAML. See [CONTEXT API](context.md) for setup, invocation and plugin ports.

## CONTEXT local resources and INTERACTION

```yaml
workers:
  context:
    localCache: { ttlMs: 3600000, maxEntries: 1000 }
    queue: { maxPending: 1024 }
  interaction:
    commands: { maxEntries: 1000, maxOutputBytes: 65536, maxErrorBytes: 8192 }
    webSearch: { timeoutMs: 30000, maxResponseBytes: 1048576 }
```

| Setting | Default / allowed range |
| --- | --- |
| workers.context.localCache.ttlMs | 3600000 / 1–2147483647 ms |
| workers.context.localCache.maxEntries | 1000 / positive safe integer |
| workers.context.queue.maxPending | 1024 / positive safe integer |
| workers.interaction.commands.maxEntries | 1000 / 1–10000 |
| workers.interaction.commands.maxOutputBytes | 65536 / 1–1048576 |
| workers.interaction.commands.maxErrorBytes | 8192 / 1–65536 |
| workers.interaction.webSearch.timeoutMs | 30000 / 1–2147483647 ms |
| workers.interaction.webSearch.maxResponseBytes | 1048576 / 1–16777216 |

Factory defaults and root YAML agree. Loaders return immutable config.context / config.interaction. Explicitly pass the corresponding groups to createInMemoryContextStore, createContextOperationQueue, createReadOnlyCommandTools and createBraveWebSearchProvider. Loading parameters does not activate tools, caching or network permissions. See the [Context example](../../examples/worker/context-retrieval.ts) and [Interaction API](interaction.md#provider-cancellation-and-bounded-web-responses).

Application code reads `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`. CONTEXT and MEMORY connection variables use `DITTO_WORKER_CONTEXT_*` and `DITTO_WORKER_MEMORY_*` in root .env.example. Environment holds credentials/connections; YAML holds behavior/capacity, with no plugin autoloading.

## Runtime Sandbox execution settings

Root YAML `runtime.sandbox.timeoutMs` (default 5000, range 1–2147483647) and `runtime.sandbox.maxOutputBytes` (default 65536, range 1–16777216) normalize to immutable `config.sandboxExecution`. Example: `createLocalSandboxExecutor({ commands: ["uname"], ...config.sandboxExecution })`. Loading settings neither grants execution permission nor constructs an executor. Applications explicitly supply executable allowlists, environment and backends; config.sandbox / Worker services still govern permissions. See the [Sandbox API](runtime.md#sandbox-api-and-local-execution).
