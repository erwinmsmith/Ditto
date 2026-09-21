# Provider API

[English](providers.md) · **简体中文** · [INFER API](infer.zh-CN.md)

Provider 实现在 `src/worker/infer/providers/`。一个 Registry、一套模型接口、一个 HTTP/SSE 传输层；OpenAI 兼容、Anthropic、Gemini 各用一个协议文件，不引入供应商 SDK。缓存后端在 `infer/cache/provider.ts`，不混入模型 Provider。

## 接口与注册

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

`invoke` 必需，`stream` 可选。stream 返回文本增量，然后恰好一个完整 result，包含 Message、动作和 usage，随后结束。Provider 返回 `SampleOutput`，INFER Node 负责转换为 `NodeResult`。自定义 Provider 应遵守 signal；SDK 会停止等待不配合的调用，但无法强制终止其内部工作。

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

| 方法 | 语义 |
| --- | --- |
| `new ProviderRegistry(providers?)` | 接受只读名称 → ModelProvider 映射，默认为空 |
| `register(name, provider): () => boolean` | 名称非空且不可重复；返回仅移除本次注册的函数 |
| `get(name?): ModelProvider` | 指定名称时精确匹配；省略且仅有一个条目时自动选择；未找到/有歧义抛 `PROVIDER_NOT_FOUND` |

`createInfer({ providers })` 和 `createInferWorker({ providers })` 同时接受 Registry 或普通名称映射。省略时，Worker 使用 `ctx.services.providers`；SDK 可通过 `createInfer({ runtime })` 使用同一个 Registry。供应商解析顺序为 `input.model.provider` → `defaultProvider` → Runtime `config.model.provider` → Registry 唯一条目。显式注入的 providers 替换 Runtime Registry，不与其合并。没有 Provider 也能使用 CACHE。

## HTTP Provider

```ts
import { createHttpProvider } from "@ditto/core/worker/infer/providers";
const provider = createHttpProvider({
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  sandbox: runtime.services.sandbox,
  timeoutMs: 30_000,
});
runtime.services.providers.register("claude", provider);
```

| 参数 | 含义 |
| --- | --- |
| `kind` | `"openai-compatible" \| "anthropic" \| "gemini"` |
| `baseUrl` | 必需，API 根地址，不是具体方法地址；仅 HTTP(S)，不得包含用户名、密码、query 或 hash |
| `apiKey?` | 仅留在 Provider 配置里；允许省略以支持本地服务 |
| `sandbox` | 必需，具有 `assert("network", origin)` 的 Sandbox；每次请求检查 |
| `timeoutMs?` | 默认 30,000，1 到 `2^31-1` 的整数；覆盖连接和响应体读取，与调用 signal 同时生效 |
| `model?` | 供应商默认模型 ID，供应用及真实验证脚本读取；Node input 仍显式提供 model |
| `maxTokensField?` | OpenAI 兼容接口的字段选择：max_completion_tokens（默认）或 max_tokens；DeepSeek/智谱配置后者 |
| `providerOptions?` | 供应商默认请求 body 扩展，如 thinking；请求级 model.providerOptions 优先，generation 最后覆盖 |
| `fetch?` | 注入 fetch 实现；默认 globalThis.fetch，用于测试或自定义传输 |

输入 `model.endpoint` 若提供，必须与 `baseUrl` 一致；禁止借请求输入将凭证发往其他地址。请求禁止重定向。非 2xx 返回 `PROVIDER_HTTP_ERROR` 和状态码，不回显错误正文。无自动重试、供应商切换或模型目录。

| 协议 | 方法路径 | 凭证/协议头 | 输出 Token 上限 |
| --- | --- | --- | --- |
| OpenAI 兼容 | `/chat/completions` | `Authorization: Bearer …` | `max_completion_tokens` 或配置的 `max_tokens` |
| Anthropic | `/messages` | `x-api-key`、`anthropic-version: 2023-06-01` | `max_tokens`，未配置默认 4096 |
| Gemini | `/models/{model}:generateContent`；流式 `:streamGenerateContent?alt=sse` | `x-goog-api-key` | `generationConfig.maxOutputTokens` |

`generation.temperature/topP/topK/stop` 映射到各协议对应字段；`seed` 支持 OpenAI 兼容和 Gemini，Anthropic 明确拒绝。具体模型是否支持字段取决于供应商。字符串 Message 通用；数组 content 为供应商原生内容块，不承诺跨协议自动转换图片等多模态格式。

`model.providerOptions` 添加供应商 body 字段。模型、消息、工具列表、流开关和候选数量由适配器控制，显式 generation 优先。OpenAI 固定 n=1；Gemini 固定 candidateCount=1，其 providerOptions.generationConfig 与 generation 合并。反思/审议采用 JSON 提示和结构校验；供应商 JSON Schema 模式可通过 providerOptions 设置。

## 工具调用与流式

SAMPLE 只返回 actionRequests；动作执行由 [ReAct Runtime 流程](../interaction-runtime.zh-CN.md#react-预定义-graph-流程) 或调用者的 Graph 完成。动作名和目标受调用者声明限制，模型不能改写路由目标。动作参数仍由目标 Worker 按其业务契约验证。

通用历史约定：assistant 的 `metadata.actionRequests` 保存动作列表；tool 的 `metadata.actionRequestId` 和 `metadata.name` 对应请求 ID 和名称。工具内容为文本或 JSON 文本。OpenAI 映射为 tool_calls/tool_call_id，Anthropic 映射为 tool_use/tool_result，Gemini 映射为 functionCall/functionResponse。

保留 Provider 返回的原始 `message.metadata`：Anthropic 的 contentBlocks（包括签名块）和 Gemini 的 parts（包括 thoughtSignature）需要在下一轮原样传回。同一供应商内回放，不应在跨供应商切换后直接复用原生多模态/签名块。Gemini 原生函数 ID 若存在会回传；没有 ID 时生成本地关联 ID，不向供应商虚构函数 ID。

流式共用 UTF-8/CRLF SSE 解码器，单帧上限为 1 Mi 个 JavaScript 字符，提前退出释放 reader。OpenAI 校验 `[DONE]`，Anthropic 校验 message_stop 与内容块闭合，Gemini 校验 finishReason；缺失终态返回 `INCOMPLETE_MODEL_OUTPUT`。增量仅包含公开 text，thinking/signature 块作为回放数据保留，不输出为 text_delta。

usage 来自供应商，缺少计数不会补成完整计数。Anthropic 的输入总数包含 cache_creation/cache_read；Gemini outputTokens 包含 thoughtsTokenCount，reasoningTokens 单列但不重复计入 totalTokens。Token 预算要求每次有 totalTokens 或完整 input/output，否则返回 `USAGE_UNAVAILABLE`；输入 Token 事前未知，因此不是付费硬上限。

## 环境配置与多供应商

```ts
import { createDitto, createInferWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
if (!config.model) throw new Error("Configure DITTO_WORKER_INFER_MODEL_PROVIDER and DITTO_WORKER_INFER_MODEL");
const response = await runtime.invoke("INFER.REASONING.SAMPLE", {
  model: config.model, messages: [{ role: "user", content: "Hello" }],
});
await runtime.close();
```

显式加载 `.env.example` 中的配置：`DITTO_SHARED_PROVIDERS=deepseek,openai,glm,claude,gemini,local`，每个名称使用 `DITTO_SHARED_PROVIDER_<NAME>_KIND/BASE_URL/API_KEY/MODEL`。名称匹配 `[a-z][a-z0-9_]*` 且不可重复。省略 BASE_URL 时，各 kind 默认分别为 `https://api.openai.com/v1`、`https://api.anthropic.com/v1`、`https://generativelanguage.googleapis.com/v1beta`。还需在 `DITTO_SHARED_SANDBOX_ALLOW_NETWORK` 配置请求 origin。

`DITTO_WORKER_INFER_MODEL_PROVIDER` 和 `DITTO_WORKER_INFER_MODEL` 必须一起配置；模型 ID 由调用方传入 model 字段。Runtime 不会隐式读取环境或文件；`loadRuntimeConfigFile` 由应用显式调用。传入自定义 `createDitto({ providers })` 时，不再从 config.providers 额外创建 Provider。

供应商行为改为 YAML 的 `shared.providers.<name>.options` 和 `maxTokensField`（仅 OpenAI 兼容协议）；默认值、覆盖顺序及迁移见 [统一配置 API](configuration.zh-CN.md)。真实配置放在根目录 .env 并由 Git 忽略，所有 Worker 通过 ctx.services.config/providers/sandbox 共享；未实现的存储后端不预设空配置项。推理模型的 maxTokens 可能同时限制隐藏推理与可见答案；预算不足会返回 length/partial，不能视为完整成功。OpenAI 兼容协议的工具消息也保留原始 reasoning_content（若存在），只作下一轮回放，不输出成 text_delta。

真实校验：`npm run check:infer:live -- --provider deepseek`。可选 `--strategies cot,tot,got`、`--cases sample,tot`、`--max-tokens 4096` 和 `--report path`。脚本对配置中的实际模型做内容断言，任何失败均非零退出；报告追加历史，包含失败，不包含凭证。详见 [真实验证报告](infer-live-report.md)。

协议参考：[Anthropic 流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Gemini 内容生成](https://ai.google.dev/api/generate-content)、[Gemini 函数调用](https://ai.google.dev/gemini-api/docs/function-calling)。离线测试使用模拟响应与本地 HTTP Worker；真实调用结果单独记录。

## 逐 API 使用示例

完整代码：[examples/infer.ts](examples/infer.ts)。下列函数共用该文件的 imports，均参与 `npm run typecheck`；函数不会在导入时自动执行。数据库、模型和 MCP 参数由应用注入，不是 Ditto 内置的模拟后端。选择需要的函数调用；写入、删除、模型调用等会产生对应的真实操作。

```ts
import { createDitto, loadRuntimeConfigFile } from "@ditto/core";
import {
  createInfer, createInferWorker, InMemoryInferCache, inferSampleNode,
  type InferClient, type ModelConfig, type TrajectoryInput, type ReflectInput,
  type DeliberateInput, type TrajectoryStrategy, type InferCacheProvider, type ModelProvider, type SampleInput,
} from "@ditto/core/worker/infer";

import { ProviderRegistry, createHttpProvider, type HttpProviderOptions } from "@ditto/core/worker/infer/providers";
```

### ProviderRegistry.register / get / unregister 与 invoke

演示注册、解析、原始模型调用与注销。ModelProvider.invoke 返回 SampleOutput，不含 NodeResult；输入中 provider 字段不会让单个 Provider 再次路由。注销不关闭连接或取消已执行调用。

```ts
export async function providerRegistryApis(provider: ModelProvider, input: SampleInput) {
  const providers = new ProviderRegistry();
  const unregister = providers.register("primary", provider);
  try {
    const selected = providers.get("primary");
    return await selected.invoke(input, { signal: AbortSignal.timeout(5_000) });
  } finally { unregister(); }
}
```

### ModelProvider.stream：原始流

stream 是可选方法，故先检查。原始流没有 SDK 的 start/step 事件；它只包含 text_delta 和一个完整 result。无 stream 时可调用 invoke，但不要声称返回真实 token 流。

```ts
export async function providerStream(provider: ModelProvider, input: SampleInput) {
  const signal = AbortSignal.timeout(5_000);
  if (!provider.stream) return provider.invoke(input, { signal });
  for await (const event of provider.stream(input, { signal })) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "result") return event.output;
  }
  throw new Error("Provider stream ended without a result");
}
```

### createHttpProvider：显式构造

完整参数见前文表格；options.sandbox 必须允许 baseUrl 的 origin。工厂只创建适配器，不立即发请求；首次 invoke/stream 才连接。

```ts
export function httpModelProvider(options: HttpProviderOptions) {
  return createHttpProvider(options);
}
// Example options: { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1",
//   apiKey: process.env.DITTO_SHARED_PROVIDER_OPENAI_API_KEY, sandbox: runtime.services.sandbox }
// Omit apiKey entirely when the endpoint has no authentication.
```
