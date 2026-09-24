# Provider、Interaction 与 Runtime 预定义流程

[English](interaction-runtime.md) | **简体中文**

本文说明当前轻量实现。规范性的节点树与公共输入输出契约以[节点体系与 API Contract](13-node-api-contract.zh-CN.md)为准。

## 模型 Provider

Provider 适配器位于 `src/worker/infer/providers/`。Runtime 与 INFER 使用同一套 `ModelProvider.invoke/stream` 和 `ProviderRegistry`，支持 OpenAI 兼容、Anthropic、Gemini。默认通过 `ctx.services.providers` 注入 Worker；本地 SDK 使用 `createInfer({ runtime })` 共享配置。构造参数、环境配置、工具消息与流式契约见 [Provider API](worker-api/providers.zh-CN.md)。供应商与模型均不会产生新的 Node Type。

## Interaction 边界

`INTERACTION` 只负责与外部世界交互的语义：

- `INTERACTION.ACT.TOOL` 调用直接注册或原生工具；
- `INTERACTION.ACT.MCP` 通过 MCP 发现或调用外部能力；
- `INTERACTION.OBSERVE` 标准化环境返回信息；
- `INTERACTION.OUTPUT` 提交本轮最终结果。

应用输入从应用/Runtime 边界传入。Worker 之间的 `invoke` 与 `emit` 是 Runtime 通信原语，不是 Interaction Node。

`INTERACTION.ACT.TOOL` 仍是一个可路由 Node，但其实现采用目录组织：

```text
src/worker/interaction/act/tool/
├── node.ts
├── registry.ts
├── read-only-commands.ts
├── web-search.ts
└── index.ts
```

```ts
import { ToolRegistry } from "@ditto/core/worker/interaction";

const tools = new ToolRegistry();
tools.register({
  name: "read_text",
  description: "读取工作区文本文件",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate: (args) => {
    if (typeof args.path !== "string") throw new Error("path 必须是字符串");
  },
  execute: async (args, context) => ({ status: "success", content: await context.services.sandbox.readText(args.path as string, context.signal) }),
});
```

`McpRegistry` 接收结构化的 `McpClient`。应用负责 SDK 选择、认证、连接生命周期和传输；Core 不依赖 MCP SDK。

客户端适配器返回中立的 `McpToolResult`，可包含内容、结构化内容、引用、`isError` 和脱敏后的结构化错误。MCP 能力发现默认合计最多 100 页、1000 项，应用可配置其他正整数上限。`isError` 为 true 但没有合规的安全错误时，Core 使用固定的 `MCP_TOOL_ERROR`，不把不可信工具内容写入诊断消息。`createInteractionNodes()` 始终注册 OBSERVE；MCP 和 OUTPUT 只有在注入注册表或应用负责的 `OutputSink` 后才注册。OUTPUT 的接收回执不代表最终送达或用户已读。

MCP 在调用客户端前验证 operation 只能是 discover/invoke；显式 server 必须非空，invoke 的 call.id/name 必须非空，arguments 必须是 JSON 对象。缺失参数、字符串、数组或不可序列化内容会被拒绝，不会被隐式转换成空对象。业务参数的 Schema 校验仍由应用适配器负责。

OUTPUT 在调用接收端前验证 deliveryId、message.role/content/name 以及 artifacts 的名称和引用。content 保留公共 MessageContent 的 JSON 语义，允许 null、数值、对象和数组。返回回执也校验 artifacts 和 metadata；回执非法时抛错，不自动重试，也不推断先前交付未发生。这些校验同样适用于 HTTP Worker 调用。

## Graph、Loop 与 Worker 使用入口

应用中的 Agent 由三部分组成：Graph 定义 Node 及数据依赖，Loop 定义迭代状态和停止条件，Worker 提供具体实现及 SDK 适配。单轮执行使用 `runtime.run(graph, input)`，循环执行使用 `runtime.loop(loopDefinition, state)`。不需要额外定义 Agent 管理层。

完整的[可运行示例](worker-api/examples/graph-loop-worker.ts)包含 Graph → Loop → Worker → Runtime 四步。运行 `npm run example:agent` 会通过 TOOL 读取 README 和 package.json，经过 OBSERVE，再由 OUTPUT 打印两次结果；无需模型或数据库密钥。

```ts
import { createInteractionWorker } from "@ditto/core/worker/interaction";

// readTextTool、connectedMcpClient、outputSink 是应用提供的实现。
const interaction = createInteractionWorker({
  tools: [readTextTool],
  mcp: { files: connectedMcpClient },
  output: outputSink,
  concurrency: 8,
});
// createDitto({ workers: [interaction, infer, memory], sandbox: ... })
```

`createInteractionWorker(options?: InteractionOptions): WorkerDefinition` 可直接放入 Runtime 的 `workers`，也可传给 `runtime.register()`。

| 配置 | 类型与行为 |
| --- | --- |
| `tools` | `readonly RegisteredTool[]` 或 `ToolRegistry`；缺省为空，始终提供 TOOL 和 OBSERVE |
| `mcp` | 服务名到 `McpClient` 的只读映射，或 `McpRegistry`；未提供时不暴露 MCP |
| `output` | `OutputSink`；未提供时不暴露 OUTPUT |
| `concurrency` | 可选正整数，限制每个 Worker 副本的并发调用数；缺省不限制 |

`index.ts` 只承担模块导出，实际执行位于 `worker.ts`、`act/tool/node.ts`、`act/tool/registry.ts`、`act/tool/read-only-commands.ts`、`act/tool/web-search.ts`、`act/mcp.ts`、`observe.ts` 和 `output.ts`。`createReadOnlyCommandTools()` 提供 14 个可选注册项：`grep`、`ls`、`cat`、`find`、`head`、`tail`、`wc`、`sort`、`uniq`、`cut`、`stat`、`file`、`du` 和 `pwd`。它们使用结构化参数和有界结果，Core 不会自动注册；应用必须显式注入工具和 `sandboxExecutor`，再开放各工具与 execute 权限。Core 只传递固定命令名和分离参数，不启动 shell；生产隔离仍由执行器负责。

`createWebSearchTool({ provider })` 提供一个可选 `web_search` 注册项。它只接受有界 query 与结果数量，同时要求 `tools:web_search` 和 Provider 精确网络 origin 权限，返回有界的 `title / url / snippet` 及 references。`createBraveWebSearchProvider({ apiKey })` 是基于原生 fetch 的 Brave Web Search 薄适配器。应用显式提供密钥，并负责配额、生命周期和任何重试策略；Core 不读取环境凭证，也不自动重试。

数组和映射在构造时注册一次；需要动态插拔时传入注册表，使用 `register()` 返回的注销函数。注册工具仍需在 Sandbox 开放对应权限。数据库适配器同样放在 MEMORY Worker：`createMemoryWorker({ store: databaseAdapter })`；Graph 继续只调用 MEMORY Node，检索仍可由数据库自身实现，或显式接到可选 RETRIEVAL。

连接、认证和 SDK 释放由应用负责。工厂不会打开或关闭 MCP/数据库连接，复用同一 Worker definition 会共享传入的实例。需要每个副本独立资源及自动释放时，使用现有 `defineWorker({ resources, dispose, nodes })` 与 `createInteractionNodes()`；不需要新增插件加载框架。env 放密钥和连接信息，YAML 放行为参数；当前工厂的工具函数和 SDK 实例通过代码注入，不能把任意插件名写入 YAML 后自动加载。

命令与其他工具组合的[完整示例](worker-api/examples/interaction-tools.ts)可通过 `npm run example:tools` 运行。MCP SDK 安装与运行方式见[示例指南](worker-api/examples/guide.zh-CN.md#mcp)。

## 四类预定义流程

公开函数直接位于 `src/runtime/graph.ts`，并由 `@ditto/core/runtime` 导出。它们是可复用的 Runtime 组合函数，不是 Node Type。

| 函数 | 固定流程 |
| --- | --- |
| `runRagFlow()` | `CONTEXT.SELECT` with `strategy: { kind: "rag" }` |
| `runSkillFlow()` | `CONTEXT.LOAD -> CONTEXT.UPDATE` (optional merge) |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL -> INTERACTION.OBSERVE -> CONTEXT.UPDATE` |
| `runMcpFlow()` | `discover` 只调用 MCP；`invoke` 执行 MCP -> OBSERVE -> CONTEXT.UPDATE |

RAG 的 embed/retrieve/rank 由注入的 createRagStrategy 管理。Tool/MCP 调用返回 Observation，并通过 ContextIngress 更新显式 Context；discover 不更新。

```ts
import { runSkillFlow, runToolCallFlow } from "@ditto/core/runtime";

const skill = await runSkillFlow(runtime, {
  context,
  sources: [{ id: "code-review", content: "Review correctness and tests." }],
});

const tool = await runToolCallFlow(runtime, {
  context: skill.context,
  call: { id: "call-1", name: "read_text", arguments: { path: "README.md" } },
});
```

应用仍可使用 `ExecutionGraph` 以其他方式组合相同的叶子 Node；四个公开函数仅标准化高频的 Context 入口路径。

## Skill 生命周期

应用解析 Skill 后，将其内容作为 sources 传入 runSkillFlow；流程调用 LOAD，可选 UPDATE。


## Sandbox 与部署

Sandbox 的文件、命令、Tool、MCP 和网络权限默认拒绝。skills 是供应用显式 assert 的权限类别，runSkillFlow 不检查或执行 Skill。Sandbox 是协作式权限服务；不可信实现应放入具备相应隔离能力的操作系统进程或容器。

Graph 定义与 Node Contract 不包含 Provider 密钥、主机地址或 Worker ID。因此 Runtime 可以在不改变语义 Node 调用的情况下，将同一 Graph 从本地执行迁移到远程 Worker。

## ReAct 预定义 Graph 流程

ReAct 放在 `src/runtime/react.ts`，是 Graph 的预定义运行流程：SAMPLE → 已声明动作 → 结果回填 → 下一轮 SAMPLE。它不是 INFER Node 或 TRAJECTORY 策略。循环状态、预算和跨 Worker 调度都由 Runtime 流程持有；所有模型计算仍由 SAMPLE 完成。

先配置 .env 中的模型连接、network origin、read 和 read_text 权限，再由 Node --env-file=.env 加载环境。下列代码按位于 docs/ 的文件给出相对导入；在其他目录调整示例路径。工具读取真实工作区文件。

```ts
import { createDitto, createInferWorker, createInteractionWorker, loadRuntimeConfigFile } from "@ditto/core";
import { readTextTool, reactFlow } from "../docs/worker-api/examples/runtime/flows.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure DITTO_WORKER_INFER_MODEL_PROVIDER and DITTO_WORKER_INFER_MODEL");
const runtime = createDitto({
  config,
  workers: [createInferWorker(), createInteractionWorker({ tools: [readTextTool] })],
});
try {
  console.log(await reactFlow(runtime, config.model));
} finally { await runtime.close(); }
```

```ts
runReactFlow(
  runtime: Pick<DittoRuntime, "run" | "services">,
  input: ReactFlowInput,
  options?: { graphId?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ReactFlowResult>;
```

```ts
export interface ReactFlowInput extends SampleInput {
  constraints?: { maxSteps?: number; maxActionCalls?: number; maxTotalTokens?: number; timeoutMs?: number };
}
export interface ReactFlowResult {
  result: Message;
  samples: SampleOutput[];
  observations: Observation[];
  actionRequests: ActionRequest[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_action_calls" | "max_tokens" | "timeout" | "cancelled" | "dependency_failed" | "error";
  usage: Usage;
  error?: { code: string; message: string };
}
```

`ReactFlowInput` 继承 SAMPLE 的 model/messages/generation/actions/metadata。Context、Memory 或计划由上游 Graph 获取并组装成 messages。输入校验错误直接抛出；运行期间错误返回 ReactFlowResult，不套 INFER NodeResult。

| 参数 | 默认与行为 |
| --- | --- |
| `graphId` | `react`；每次 SAMPLE/action 都经过 runtime.run，保留 Graph execution scope；各次 run 有独立 runId |
| `maxSteps` | Runtime config.maxTurns（默认 8）；最大 SAMPLE 次数，正整数 |
| `maxActionCalls` | Runtime config.react.maxActionCalls，回退值为 16，非负整数；0 禁止执行动作，但保留模型产生的请求 |
| `maxTotalTokens` | Runtime config.react.maxTotalTokens，未配置时不限；已累计 usage 限制后续采样，不是单次请求的付费硬上限 |
| `timeoutMs` | constraints 与 options/Runtime config.timeoutMs 的较小值；库回退值为 30 秒，根目录 YAML 为 120 秒 |
| `signal` | 向本地模型/动作传递协作取消，停止后续调度；远程请求/动作可能继续执行 |

调用方在 `ActionDescriptor.target` 中绑定直接工具、MCP 服务端及工具，或公开 Node。未指定目标时使用 TOOL。MCP 的 `operation` 固定为 `invoke`；模型参数不能决定服务端或路由。TOOL/MCP 结果经过 OBSERVE 后才反馈给 SAMPLE。多个动作顺序执行；结构化的 `failed` 结果进入下一轮 SAMPLE，`cancelled`、`timeout`、`unknown` 则停止后续动作。基础设施异常不伪造成观察结果。Core 不自动重试可能影响外部系统的操作。

成功返回 completed；预算/超时/错误中止且已有 SAMPLE 时返回 partial，否则 failed。actionRequests 仅保留尚未处理的请求；超时中的动作结果未知，仍保留 pending，调用者不能据此认定动作未发生。成功观察回填到下一轮工具消息，原始供应商 metadata 保持完整。步数耗尽且没有下一轮可消费观察时，不再执行新动作。

Token 计数缺失返回 USAGE_UNAVAILABLE；重复 action ID、未声明动作和非法模型输出均停止流程。与其他 Runtime Graph 一致，本地 deadline/signal 会传给模型与动作 handler；跨进程调用尚无远端取消协议。需要先规划时，在上游 Graph 调用 SAMPLE，再将计划传给此流程。

采样与预算默认参数见 [统一配置 API](worker-api/configuration.zh-CN.md)。

长期记忆搜索使用 MEMORY.SEARCH，Graph 检查 NodeResult 并显式映射到 CONTEXT.UPDATE；详见 [MEMORY API](worker-api/memory.zh-CN.md)。

完整输入字段、返回值和各流程调用示例见 [预定义流程 API](worker-api/flows.zh-CN.md)。
