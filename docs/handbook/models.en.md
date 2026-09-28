# Model configuration and inference

The INFER Worker handles sampling, reasoning trajectories, reflection, deliberation and inference caching. Other Workers and application Graphs prepare context, execute tools and save results.

## 1. Configure a provider

Copy `.env.example` to `.env` and supply the actual endpoint, key and model ID:

```dotenv
DITTO_SHARED_PROVIDERS=primary
DITTO_SHARED_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_SHARED_PROVIDER_PRIMARY_BASE_URL=https://your-provider.example/v1
DITTO_SHARED_PROVIDER_PRIMARY_API_KEY=YOUR_API_KEY
DITTO_SHARED_PROVIDER_PRIMARY_MODEL=YOUR_MODEL_ID
DITTO_WORKER_INFER_MODEL_PROVIDER=primary
DITTO_WORKER_INFER_MODEL=YOUR_MODEL_ID
DITTO_SHARED_SANDBOX_ALLOW_NETWORK=https://your-provider.example
```

`primary` is a registration name, not a model name. HTTP provider kinds include `openai-compatible`, `anthropic` and `gemini`; supported models and parameters depend on the service. The Sandbox allowlist uses URL origins, while the API base URL retains the provider's required path.

```ts
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
const config = loadRuntimeConfig(process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
```

Start with `node --env-file=.env app.ts`. The configuration loader does not locate `.env` or automatically read YAML. For YAML, explicitly call `loadRuntimeConfigFile("ditto.yaml",process.env)`. See the [configuration reference](../worker-api/configuration.md) for precedence, behavior settings and credentials.

## 2. First sample

```ts
import { graph } from "@codesoul-co/ditto/runtime";
const answer = graph<string>("answer")
  .node("sample", "INFER.REASONING.SAMPLE", [], question => ({
    model: config.model!,
    messages: [{ role: "user", content: question }],
    generation: { maxTokens: 512 },
  }));
try {
  if (!config.model) throw new Error("Configure a model first");
  const { sample } = await runtime.run(answer, "Explain the relationship between Nodes, Workers and Graphs.");
  if (sample.status !== "success" || !sample.output) {
    throw new Error(sample.error?.message ?? "Inference failed");
  }
  console.log(sample.output.message.content);
} finally { await runtime.close(); }
```

Combine this code with the initialization above. It checks the inference entry point; a complete Agent also needs Context, Memory, tools and delivery. See the [application entry point](agent.en.md).

## 3. Convert Context into model messages

`CONTEXT.SELECT` returns `ContextSelection`; items are in `selection.context.items`. Roles loaded from messages are in `item.metadata.role`, not `item.role`. Content can be text, JSON or references and must be mapped to message types supported by the model.

For text conversations, validate system/user/assistant roles and string content before preserving the role. Treat retrieved pages and tool output as evidence or tool messages, not system instructions.

See the complete mapping in [agent.ts](../../examples/package-basics/agent.ts). Provider messages and generic contract messages have different multimodal structures; a type assertion does not perform conversion.

## 4. Choose an inference node

| Node | Use | Downstream checks |
| --- | --- | --- |
| SAMPLE | One generation or a tool action request | Outer status, message and actions |
| TRAJECTORY | Multi-step reasoning, CoT/ToT/GoT or self-consistency | Outer success and inner completed status |
| REFLECT | Critique, revise or iteratively improve a result | Review and revision meet application requirements |
| DELIBERATE | Rank, evaluate or combine candidates | Preserve provenance and rationale; validate structure |
| CACHE.LOOKUP / WRITE / INVALIDATE | Explicit inference caching | Hit/miss, expiration and invalidation scope |

These operations do not automatically create a persistent Agent. Internal inference budgets and application Loop Graph counts are different. Bound tokens, model calls, total time and external actions as appropriate.

## 5. Model-proposed Tool/MCP actions

Pass action descriptors to SAMPLE and map returned `actions` to an allowed call table. INFER proposes requests; it does not execute operations merely because a model emits a name. Actual actions run through `INTERACTION.ACT.TOOL` or an MCP Graph.

The cycle is: propose → validate name/arguments → check permissions/approval → execute → OBSERVE → update Context → infer again. Use one Loop for the cycle. See [Tools](tools.en.md) and the [ReAct application](../../examples/patterns/react/README.md).

## 6. Providers, streaming and cache

`ProviderRegistry.register(name,provider)` accepts a `ModelProvider` adapter. Built-in HTTP providers use the Runtime Sandbox. Custom SDK adapters must implement network policy, cancellation and response validation.

The `createInfer` SDK offers streaming methods, but it is not a remote proxy for a registered Worker. Runtime `invoke` and ordinary Graph nodes return final results; do not assume they return the SDK's AsyncIterable. See [INFER streaming](../worker-api/infer.md).

The default inference cache is instance-local memory, independent of Redis Context and long-term Memory. Inject a shared `InferCacheProvider` for cross-replica reuse. Keys should include the model, input, output-affecting parameters and relevant data/prompt versions. The application controls retention of sensitive data.

## 7. Troubleshooting

| Problem | Check in order |
| --- | --- |
| Provider unavailable | Environment loaded, registration names match, default model configured |
| Network denied | Origin allowlist, base URL, actual proxy/SDK destination |
| Timeout or cancellation | Inference timeout, outer Loop signal, provider signal forwarding |
| Invalid output format | Text versus structured output; validate with the application schema before writes |
| Unknown action | Advertise only allowed actions; revalidate registry membership and permissions |

[INFER API](../worker-api/infer.md) · [Providers](../worker-api/providers.md) · [Configuration](../worker-api/configuration.md)
