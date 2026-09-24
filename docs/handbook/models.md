# 模型配置与推理

INFER Worker 负责模型采样、推理轨迹、反思、审议和推理缓存。Agent 的上下文准备、工具执行、结果保存由其他 Worker 与应用 Graph 完成。

## 1. 配置供应商

复制 `.env.example` 为 `.env`，替换供应商的真实地址、密钥和模型 ID：

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

`primary` 是注册名称，不是模型名称。支持的 HTTP kind 有 `openai-compatible`、`anthropic`、`gemini`；模型 ID 和可用参数以你所接入的服务为准。Sandbox 网络列表使用 URL origin，API base URL 则保留供应商要求的路径。

```ts
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
const config = loadRuntimeConfig(process.env);
const runtime = createDitto({ config, workers: [createInferWorker()] });
```

启动命令为 `node --env-file=.env app.ts`。配置加载器不会自行寻找 `.env`；也不会在未指定时自动读取 YAML。需要 YAML 时显式调用 `loadRuntimeConfigFile("ditto.yaml", process.env)`。环境覆盖、行为参数与凭据分组见[配置参考](../worker-api/configuration.zh-CN.md)。

## 2. 第一次采样

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
  const { sample } = await runtime.run(answer, "解释 Node、Worker 和 Graph 的关系。");
  if (sample.status !== "success" || !sample.output) {
    throw new Error(sample.error?.message ?? "Inference failed");
  }
  console.log(sample.output.message.content);
} finally { await runtime.close(); }
```

这里的配置与 runtime 接上节初始化代码。它验证推理入口；完整 Agent 还需要 Context、Memory、工具和交付，见[应用入口](agent.md)。

## 3. 将 Context 转为模型消息

`CONTEXT.SELECT` 返回 `ContextSelection`，消息内容位于 `selection.context.items`。由 Message 载入的角色在 `item.metadata.role`，不在 `item.role`。内容可能是字符串、JSON 或引用块，必须按任务映射到模型支持的消息类型。

对文本会话，可以校验 role 是 system/user/assistant，检查 content 为 string 后保留角色；检索到的网页、工具输出应按资料或 tool 消息处理。不要把每条外部资料改成 system。

完整映射见 [agent.ts](../../examples/package-basics/agent.ts)。模型专用 Message 与通用 contracts Message 的多模态结构不同，不能仅靠类型断言绕过转换。

## 4. 按任务选择推理节点

| 节点 | 适合 | 下游检查 |
| --- | --- | --- |
| SAMPLE | 一次生成，或提出工具动作 | 外层 status、message、actions 是否符合预期 |
| TRAJECTORY | 多步推理、CoT/ToT/GoT、自一致性等 | 外层 success 后还要检查内部轨迹是否 completed |
| REFLECT | 对已有答案批评、改写、迭代 | 审查与修订结果是否满足应用要求 |
| DELIBERATE | 对多个候选排序、评估或综合 | 保留候选来源与判定理由，验证输出结构 |
| CACHE.LOOKUP / WRITE / INVALIDATE | 显式推理缓存 | hit/miss、有效期和失效范围 |

这些节点不会自动变成持久化 Agent。推理节点的内部预算与应用 Loop 的 Graph 次数是不同计数，应用需要同时限制 token、模型调用次数、总时间和外部动作次数。

## 5. 模型提出 Tool/MCP 动作

给 SAMPLE 传 `actions` 描述，并将 provider 返回的 `actions` 映射到受控调用表。INFER 只产生动作请求；它不会因为模型输出 `delete_all` 就执行系统操作。实际动作交给 `INTERACTION.ACT.TOOL` 或 MCP Graph。

常规步骤：生成动作 → 校验名称与参数 → 检查权限/审批 → 执行 → OBSERVE → 更新 Context → 下一轮推理。用一次 Loop 控制整个循环。详见 [Tool](tools.md) 和 [ReAct 完整任务](../../examples/patterns/react/README.zh-CN.md)。

## 6. Provider、流式和缓存

`ProviderRegistry.register(name, provider)` 支持接入符合 `ModelProvider` 的适配器。原生 HTTP Provider 使用 Runtime Sandbox；自定义 SDK 适配器需自行落实网络、取消和响应校验。

SDK `createInfer` 的 stream 方法提供流式事件，但它不是已注册 Worker 的远程代理。Runtime 普通 `invoke`/Graph 节点返回最终结果，不应假定等同于 SDK 的 AsyncIterable。流式协议、事件类型与 SDK 示例见 [INFER 的流式章节](../worker-api/infer.zh-CN.md#8-流式事件)。

推理缓存默认是实例内内存缓存；它与 Redis Context、长期 Memory 均独立。跨副本复用需要显式注入共享 `InferCacheProvider`。缓存键要包含模型、输入、影响输出的参数及应用所需的数据/提示版本，敏感数据的保存规则由应用决定。

## 7. 常见失败

| 问题 | 排查顺序 |
| --- | --- |
| Provider 不可用 | `.env` 是否加载 → 注册名称是否一致 → 默认模型配置 |
| 网络拒绝 | origin allowlist → base URL → 代理/SDK 的实际访问地址 |
| 超时或取消 | 单次推理 timeout → 外层 Loop signal → provider 是否传递取消 |
| 输出格式错误 | 区分模型文本与结构化结果；用应用 schema 校验后再写业务系统 |
| 工具动作不存在 | 仅公布允许动作，校验返回动作仍在注册表与权限内 |

[逐节点完整 API](../worker-api/infer.zh-CN.md) · [Provider 实现](../worker-api/providers.zh-CN.md) · [配置](../worker-api/configuration.zh-CN.md)
