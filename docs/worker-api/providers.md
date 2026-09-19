# Provider API

**English** · [简体中文](providers.zh-CN.md) · [INFER API](infer.md)

`src/worker/infer/providers/` contains one registry, one model interface and one HTTP/SSE transport. OpenAI-compatible, Anthropic and Gemini each have a protocol file, with no vendor SDK dependencies. Cache backends live in `infer/cache/provider.ts`.

## Interface and registration

```ts
import type { SampleInput, SampleOutput } from "@ditto/core/worker/infer";
export type ModelStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "result"; output: SampleOutput };
export interface ModelProvider {
  invoke(input: SampleInput, options: { signal: AbortSignal }): Promise<SampleOutput>;
  stream?(input: SampleInput, options: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
```

invoke is required; stream is optional. Streams yield public text deltas, then exactly one complete result with message, actions and usage, then end. Providers return SampleOutput; INFER adds the NodeResult envelope. Custom providers should honor signal. The SDK stops waiting for uncooperative calls but cannot forcibly terminate their work.

```ts
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";
const providers = new ProviderRegistry({
  fixture: { invoke: async input => ({
    message: { role: "assistant", content: `Received ${input.messages.length} messages` },
    finishReason: "stop",
  }) },
});
const remove = providers.register("other", anotherProvider);
const provider = providers.get("fixture");
remove();
```

| Method | Semantics |
| --- | --- |
| `new ProviderRegistry(providers?)` | Optional readonly name → ModelProvider map; empty by default |
| `register(name, provider): () => boolean` | Reject empty/duplicate names; return a function removing only this registration |
| `get(name?): ModelProvider` | Exact lookup when named; omitted name selects a sole entry; missing/ambiguous selection throws PROVIDER_NOT_FOUND |

createInfer({ providers }) and createInferWorker({ providers }) accept a registry or name map. Workers default to ctx.services.providers; createInfer({ runtime }) shares the same registry. Selection: input.model.provider → defaultProvider → Runtime config.model.provider → sole registry entry. Explicit providers replace, rather than merge with, the Runtime registry. CACHE works without model providers.

## HTTP providers

```ts
import { createHttpProvider } from "@ditto/core/worker/infer/providers";
const provider = createHttpProvider({
  kind: "anthropic", baseUrl: "https://api.anthropic.com/v1",
  ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  sandbox: runtime.services.sandbox, timeoutMs: 30_000,
});
runtime.services.providers.register("claude", provider);
```

| Option | Meaning |
| --- | --- |
| kind | `"openai-compatible" \| "anthropic" \| "gemini"` |
| baseUrl | Required API base, not method URL; HTTP(S), without credentials/query/hash |
| apiKey? | Provider configuration only; optional for local endpoints |
| sandbox | Required Sandbox implementing assert("network", origin), checked on every request |
| timeoutMs? | Default 30,000; integer 1–2^31−1; covers connection/body reads and combines with caller signal |
| model? | Provider model ID for applications/live runner; Node input still supplies model explicitly |
| maxTokensField? | OpenAI-compatible token-limit field: max_completion_tokens (default) or max_tokens for DeepSeek/Zhipu |
| providerOptions? | Provider body defaults, e.g. thinking; input.model.providerOptions overrides defaults; generation takes precedence |
| fetch? | Optional injected fetch; defaults to globalThis.fetch |

If supplied, input.model.endpoint must match baseUrl. Redirects are rejected. Non-2xx responses produce PROVIDER_HTTP_ERROR with status, without echoing response bodies. No automatic retries, vendor fallback or model catalog.

| Protocol | Method path | Authentication/protocol headers | Output token limit |
| --- | --- | --- | --- |
| OpenAI-compatible | /chat/completions | Authorization: Bearer … | max_completion_tokens or configured max_tokens |
| Anthropic | /messages | x-api-key, anthropic-version: 2023-06-01 | max_tokens; defaults to 4096 |
| Gemini | /models/{model}:generateContent; streaming :streamGenerateContent?alt=sse | x-goog-api-key | generationConfig.maxOutputTokens |

Generation temperature/topP/topK/stop map to protocol fields. Seed is forwarded for OpenAI-compatible/Gemini and rejected for Anthropic. Individual model support varies. String messages are portable; array content is vendor-native, without automatic cross-protocol multimodal conversion.

model.providerOptions adds body fields. The adapter controls model/messages/tools/stream/candidate count; explicit generation takes precedence. OpenAI fixes n=1; Gemini fixes candidateCount=1 and merges providerOptions.generationConfig with generation. Reflection/deliberation use JSON prompts and validation; provider-specific schema modes may be configured through providerOptions.

## Tool history and streaming

SAMPLE returns actionRequests without execution. Use the [ReAct Runtime flow](../interaction-runtime.md#react-predefined-graph-flow) or application Graphs to execute them. Caller declarations control names and routing targets; target Workers validate business arguments.

History uses assistant.metadata.actionRequests and tool.metadata.actionRequestId/name. Tool content is text or JSON text. These map to OpenAI tool_calls/tool_call_id, Anthropic tool_use/tool_result, and Gemini functionCall/functionResponse.

Keep the returned message.metadata intact: Anthropic contentBlocks preserve signed blocks; Gemini parts preserve thoughtSignature. Replay native blocks within the same vendor; do not assume they survive cross-vendor switching. Native Gemini function IDs are replayed when supplied; otherwise local IDs associate observations without inventing wire IDs.

A shared decoder handles split UTF-8/CRLF SSE, caps individual frames at 1 Mi JavaScript characters, and releases readers on exit. OpenAI requires [DONE], Anthropic requires message_stop and closed content blocks, and Gemini requires finishReason. Missing termination produces INCOMPLETE_MODEL_OUTPUT. Only public text becomes text_delta; thinking/signature blocks remain opaque replay data.

Usage comes from provider counters; missing counters are not fabricated. Anthropic input includes cache creation/read tokens. Gemini outputTokens includes thoughtsTokenCount; reasoningTokens is also reported but not counted twice in totalTokens. Token budgets require totalTokens or complete input/output accounting per call, otherwise USAGE_UNAVAILABLE. Input token cost is unknown beforehand, so this is not a hard billing cap.

## Environment and multiple providers

```ts
import { createDitto, createInferWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
if (!config.model) throw new Error("Configure DITTO_MODEL_PROVIDER and DITTO_MODEL");
const response = await runtime.invoke("INFER.REASONING.SAMPLE", {
  model: config.model, messages: [{ role: "user", content: "Hello" }],
});
await runtime.close();
```

Load the example configuration explicitly: DITTO_PROVIDERS=deepseek,openai,glm,claude,gemini,local, with DITTO_PROVIDER_<NAME>_KIND/BASE_URL/API_KEY/MODEL for each entry. Names match [a-z][a-z0-9_]* and must be unique. Default base URLs by kind are https://api.openai.com/v1, https://api.anthropic.com/v1, and https://generativelanguage.googleapis.com/v1beta. Allow the corresponding origins through DITTO_ALLOW_NETWORK.

DITTO_MODEL_PROVIDER and DITTO_MODEL must be configured together; callers supply the model field on each request. Runtime never implicitly loads environment/files. Supplying createDitto({ providers }) skips provider construction from config.providers.

Provider behavior now lives in YAML as `providers.<name>.options` and `maxTokensField` (OpenAI-compatible only). See the [shared configuration API](configuration.md) for defaults, overrides and migration. Keep real configuration in the ignored root .env. Every Worker shares ctx.services.config/providers/sandbox; unused storage options are not invented. Reasoning models may count internal reasoning against maxTokens, so an exhausted budget produces length/partial rather than a complete success. Compatible tool messages also retain original reasoning_content when supplied, for replay only, never text_delta.

Run real checks explicitly: npm run check:infer:live -- --provider deepseek. Options: --strategies cot,tot,got, --cases sample,tot, --max-tokens 4096, and --report path. Assertions check content as well as execution; any failure exits nonzero. Reports append history including failures without credentials. See the [live verification report](infer-live-report.md).

Protocol references: [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Gemini generation](https://ai.google.dev/api/generate-content), [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling). Offline checks use fixtures/local HTTP; real provider results are recorded separately.
