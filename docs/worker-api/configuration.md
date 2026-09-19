# Shared configuration API

[简体中文](configuration.zh-CN.md) · [Worker API](README.md)

The root [`ditto.yaml`](../../ditto.yaml) contains versioned behavior defaults. [`.env.example`](../../.env.example) is the deployment template; actual `.env` credentials are ignored by Git. Load environment variables with Node `--env-file=.env`, then explicitly load YAML once at application startup. Importing the library or creating an unconfigured Runtime reads neither files nor environment variables.

```ts
import { createDitto, createInfer, createInferWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
const infer = createInfer({ runtime });
if (!config.model) throw new Error("Configure the default model in .env");
const result = await infer.reasoning.trajectory({
  model: config.model,
  messages: [{ role: "user", content: "Compute 17 * 23. Return only the integer." }],
  strategy: { name: "tot" }, // breadth, depth and beamWidth come from YAML
});
await runtime.close();
```

## Ownership and loaders

| Source | Settings |
| --- | --- |
| `.env` | DITTO_ENV, DITTO_WORKSPACE; enabled DITTO_PROVIDERS; paired DITTO_MODEL_PROVIDER/DITTO_MODEL; per-provider DITTO_PROVIDER_<NAME>_KIND/BASE_URL/API_KEY/MODEL; DITTO_ALLOW_NETWORK/TOOLS/MCP/SKILLS/READ/WRITE/EXECUTE permissions; explicit HTTP Worker bootstrap token |
| `ditto.yaml` | Runtime timeout and ReAct turns, INFER generation/trajectory budgets/strategy parameters, ReAct action budget, provider request behavior |
| Node input | Messages, model, candidates, criteria and optional per-request overrides |

```ts
loadRuntimeConfigFile(path = "ditto.yaml", env = process.env): RuntimeConfig
loadRuntimeConfig(env = process.env, settings: RuntimeSettings = {}): RuntimeConfig
```

The file loader reads UTF-8 YAML relative to the current working directory. The second loader takes an object without file access. Both return an immutable snapshot containing environment, workspace, model, providers, timeoutMs, maxTurns, infer, react and sandbox. All Workers access it through ctx.services.config. Reload and recreate the Runtime after editing YAML; there is no per-call file I/O or hot reload.

Missing/empty files, non-object roots, unknown keys, duplicate keys, aliases and invalid values fail at startup. YAML does not interpolate environment variables or accept deployment fields such as apiKey/baseUrl. Provider options are request parameters, never a place for credentials. Old DITTO_TIMEOUT_MS, DITTO_MAX_TURNS and DITTO_PROVIDER_*_OPTIONS/MAX_TOKENS_FIELD now throw a migration error if present in env. Custom createDitto({ providers }) skips HTTP provider construction from config.

## YAML fields

All fields are optional. Request values take precedence over configuration, then library fallback defaults.

| Path | Meaning / validation | Library fallback / checked-in YAML |
| --- | --- | --- |
| runtime.timeoutMs | INFER/ReAct deadline, integer 1–2147483647 ms | 30000 / 120000 |
| runtime.maxTurns | ReAct default turns, positive safe integer | 8 / 8 |
| infer.generation.maxTokens | Per-generation token limit, positive safe integer | Provider default / 4096 |
| infer.generation.temperature/topP/topK/stop/seed | [GenerationConfig](infer.md): 0–2 / 0–1 / positive integer / nonempty strings / safe integer | Unspecified |
| infer.constraints.maxSteps | Total model calls per trajectory, including ranking/merging, positive safe integer | 16 / 16 |
| infer.constraints.maxTotalTokens | Total trajectory tokens, positive safe integer; requires provider usage | Unlimited / 64000 |
| infer.constraints.timeoutMs | Additional trajectory deadline, same range as runtime.timeoutMs | Unspecified |
| infer.strategies.cot.rounds | Linear solution rounds, 1–64 | 2 / 2 |
| infer.strategies.long-cot.rounds | Extended linear solution rounds, 1–64 | 4 / 4 |
| infer.strategies.tot.breadth/depth/beamWidth | Branches per parent / depth / retained frontier width, each 1–16 | 3/2/2 / 2/2/2 |
| infer.strategies.got.breadth/depth | Contributions per layer / aggregation layers, each 1–16 | 3/2 / 2/2 |
| infer.strategies.self-consistency.candidates | Independent samples, 1–16 | 3 / 3 |
| react.maxActionCalls | Maximum ReAct actions, nonnegative safe integer | 16 / 16 |
| react.maxTotalTokens | Total ReAct sampling tokens, positive safe integer | Unlimited / 64000 |
| providers.<name>.maxTokensField | max_tokens or max_completion_tokens; OpenAI-compatible only | Adapter uses max_completion_tokens when omitted |
| providers.<name>.options | Native provider request object, e.g. thinking settings | Empty |

Provider names in YAML configure behavior without enabling providers. DITTO_PROVIDERS selects the active names; inactive YAML entries can remain as shared templates.

## Overrides and budgets

Generation, constraints and the selected strategy's options merge by field without mutating caller input. Setting only strategy.options.depth keeps the configured breadth/beamWidth. Nested SAMPLE calls from REFLECT and DELIBERATE inherit generation defaults too.

createInfer({ runtime }) and the Runtime Worker share these defaults. InferOptions.defaults?: InferSettings supports a standalone SDK or a Worker override: when supplied, it **replaces the entire Runtime infer defaults object**; when omitted, defaults come from Runtime. Custom strategies remain registered as functions using strategies, with custom options supplied in each request.

Call timeoutMs overrides the SDK/Worker option, then Runtime timeout. Effective trajectory timeout is the minimum of that value and constraints.timeoutMs; request constraints can override their YAML defaults. Nested generation is capped by both maxTokens and the remaining total-token budget. Increasing depth can exhaust maxSteps or maxTotalTokens and return partial with an explicit stopReason. The checked-in ToT settings use 8 model calls; GoT uses 6.

runReactFlow remains a Runtime graph preset. It uses runtime.maxTurns, react budgets and infer.generation, independently of trajectory strategy settings.

`npm run check:infer:live -- --provider deepseek` loads this same YAML. `--max-tokens` overrides generation for that experiment only. Reports record effective defaults and actual outcomes; see [live verification](infer-live-report.md).
