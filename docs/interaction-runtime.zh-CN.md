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

体系中不存在 `INTERACTION.COMMUNICATE`。应用输入从应用/Runtime 边界传入。Worker 之间的 `invoke` 与 `emit` 是 Runtime 通信原语，不是 Interaction Node。

`INTERACTION.ACT.TOOL` 仍是一个可路由 Node，但其实现采用目录组织：

```text
src/worker/interaction/act/tool/
├── node.ts
├── registry.ts
├── index.ts
└── linux-commands/     # 注册工具实现，不是 Node Type
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
  execute: async (args, context) => context.services.sandbox.readText(args.path as string),
});
```

`McpRegistry` 接收结构化的 `McpClient`。应用负责 SDK 选择、认证、连接生命周期和传输；Core 不依赖 MCP SDK。

## 四类预定义流程

公开函数直接位于 `src/runtime/graph.ts`，并由 `@ditto/core/runtime` 导出。它们是可复用的 Runtime 组合函数，不是 Node Type；仓库不再保留 `src/presets` package。

| 函数 | 固定流程 |
| --- | --- |
| `runRagFlow({ scope: "context" })` | `CONTEXT.RAG.RETRIEVE -> CONTEXT.RAG.RANK -> CONTEXT.UPDATE` |
| `runRagFlow({ scope: "memory" })` | `MEMORY.SEARCH -> mapMemory -> CONTEXT.UPDATE` |
| `runSkillFlow()` | `CONTEXT.SKILL` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL -> CONTEXT.UPDATE` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP -> CONTEXT.UPDATE` |

RAG 的 `EMBED` 用于表示或索引准备，因此刻意不进入查询时流程。每个函数接收 Runtime client 和当前 `Context`，返回来源结果与更新后的 Context。不同来源的数据统一通过 `ContextIngress` 边界进入 `CONTEXT.UPDATE`。

```ts
import { runSkillFlow, runToolCallFlow } from "@ditto/core/runtime";

const skill = await runSkillFlow(runtime, {
  context,
  skill: { name: "code-review", instructions: "Review correctness and tests." },
});

const tool = await runToolCallFlow(runtime, {
  context: skill.context,
  call: { id: "call-1", name: "read_text", arguments: { path: "README.md" } },
});
```

应用仍可使用 `ExecutionGraph` 以其他方式组合相同的叶子 Node；四个公开函数仅标准化高频的 Context 入口路径。

## Skill 生命周期

应用解析 Skill 后传入 runSkillFlow；流程调用 CONTEXT.SKILL 激活它。MEMORY 不负责 Skill 管理。

`SkillRegistry` 位于 context 目录，提供带 Sandbox 检查的进程内注册/读取。长期 Skill 管理由应用实现。

## Sandbox 与部署

文件、命令、Tool、MCP、Skill 和网络访问保持默认拒绝。Sandbox 是协作式权限服务；不可信实现应放入具备相应隔离能力的操作系统进程或容器。

Graph 定义与 Node Contract 不包含 Provider 密钥、主机地址或 Worker ID。因此 Runtime 可以在不改变语义 Node 调用的情况下，将同一 Graph 从本地执行迁移到远程 Worker。

## ReAct 预定义 Graph 流程

ReAct 放在 `src/runtime/react.ts`，是 Graph 的预定义运行流程：SAMPLE → 已声明动作 → 结果回填 → 下一轮 SAMPLE。它不是 INFER Node 或 TRAJECTORY 策略。循环状态、预算和跨 Worker 调度都由 Runtime 流程持有；所有模型计算仍由 SAMPLE 完成。

```ts
import { runReactFlow, createInferWorker, defineWorker } from "@ditto/core";
runtime.register(createInferWorker());
runtime.register(defineWorker({ type: "INTERACTION", nodes: {
  "INTERACTION.ACT.TOOL": async ({ call }) => ({
    source: `tool:${call.name}`, content: { found: true },
  }),
} }));
const result = await runReactFlow(runtime, {
  model: { provider: "primary", model: "your-model-id" },
  messages: [{ role: "user", content: "Search and answer." }],
  actions: [{ name: "search", inputSchema: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"],
  } }],
  constraints: { maxSteps: 8, maxActionCalls: 4, maxTotalTokens: 16_000 },
}, { graphId: "search-agent", timeoutMs: 20_000 });
console.log(result.status, result.result, result.observations);
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
| `signal` | 取消等待与后续调度；已派发的远程请求/动作可能继续执行 |

未指定 targetNode 时路由到 INTERACTION.ACT.TOOL，输入包装成 `{ call: { id, name, arguments } }`；其他 targetNode 直接接收 arguments，因此动作 schema 必须符合目标公共 Contract。目标只能来自调用者 action descriptor。多个动作顺序执行；目标失败后记录 observation 并停止，不自动重试。目标为 MCP 时使用 INTERACTION.ACT.MCP，并让 arguments 包含其 operation/server/call 契约。

成功返回 completed；预算/超时/错误中止且已有 SAMPLE 时返回 partial，否则 failed。actionRequests 仅保留尚未处理的请求；超时中的动作结果未知，仍保留 pending，调用者不能据此认定动作未发生。成功观察回填到下一轮工具消息，原始供应商 metadata 保持完整。步数耗尽且没有下一轮可消费观察时，不再执行新动作。

Token 计数缺失返回 USAGE_UNAVAILABLE；重复 action ID、未声明动作和非法模型输出均停止流程。与其他 Runtime Graph 一致，没有跨 Worker 取消协议；deadline 只停止本流程等待和后续调度。需要先规划时，在上游 Graph 调用 SAMPLE，再将计划传给此流程；不保留一个重复的 plan-and-act 策略。

采样与预算默认参数见 [统一配置 API](worker-api/configuration.zh-CN.md)。

Memory RAG 需要显式 mapMemory 回调；参见 [MEMORY API](worker-api/memory.zh-CN.md)。SEARCH 失败时不会调用 CONTEXT.UPDATE。
