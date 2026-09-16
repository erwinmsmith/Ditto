# Provider、Interaction 与 Runtime 预定义流程

[English](interaction-runtime.md) | **简体中文**

本文说明当前轻量实现。规范性的节点树与公共输入输出契约以[节点体系与 API Contract](13-node-api-contract.zh-CN.md)为准。

## 模型 Provider

Provider 适配器保持在扁平目录 `src/worker/infer/providers/` 中。`PROVIDERS` 是 `INFER` 下的实现边界，不是可路由 Node，也不是供应商分类树。在不同实现真正需要独立结构前，不新增供应商子目录。

`ProviderRegistry` 按名称解析 Provider。每个适配器实现固定边界 `ModelProvider.invoke(ProviderRequest): Promise<ModelOutput>`。Provider 选择、凭证、模型 ID、部署位置和副本数均不会产生新的 Node Type。

```ts
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";

const providers = new ProviderRegistry();
providers.register("custom", {
  invoke: async (request) => ({
    message: { role: "assistant", content: `已处理 ${request.input.messages.length} 条消息` },
  }),
});
```

内置 HTTP 适配器只是可选便利实现。自定义 SDK 适配器可通过同一接口注册。Core 不维护模型目录、不自动选择供应商，也不会把供应商定义成 Node。

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
| `runRagFlow({ scope: "memory" })` | `MEMORY.RAG.RETRIEVE -> MEMORY.RAG.RANK -> CONTEXT.UPDATE` |
| `runSkillFlow()` | `MEMORY.SKILL -> CONTEXT.UPDATE` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL -> CONTEXT.UPDATE` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP -> CONTEXT.UPDATE` |

RAG 的 `EMBED` 用于表示或索引准备，因此刻意不进入查询时流程。每个函数接收 Runtime client 和当前 `Context`，返回来源结果与更新后的 Context。不同来源的数据统一通过 `ContextIngress` 边界进入 `CONTEXT.UPDATE`。

```ts
import { runSkillFlow, runToolCallFlow } from "@ditto/core/runtime";

const skill = await runSkillFlow(runtime, {
  context,
  name: "code-review",
});

const tool = await runToolCallFlow(runtime, {
  context: skill.context,
  call: { id: "call-1", name: "read_text", arguments: { path: "README.md" } },
});
```

应用仍可使用 `ExecutionGraph` 以其他方式组合相同的叶子 Node；四个公开函数仅标准化高频的 Context 入口路径。

## Skill 生命周期

`MEMORY.SKILL` 保存或读取可持久化的程序性知识；`CONTEXT.SKILL` 表示本轮 working set 中已激活的 Skill。预定义 Skill 流程读取 `MEMORY.SKILL`，再通过 `CONTEXT.UPDATE` 写入指令，不额外创造 Skill Node。

`SkillRegistry` 是轻量的进程内参考实现。持久化存储可以独立实现相同的 Node Contract。

## Sandbox 与部署

文件、命令、Tool、MCP、Skill 和网络访问保持默认拒绝。Sandbox 是协作式权限服务；不可信实现应放入具备相应隔离能力的操作系统进程或容器。

Graph 定义与 Node Contract 不包含 Provider 密钥、主机地址或 Worker ID。因此 Runtime 可以在不改变语义 Node 调用的情况下，将同一 Graph 从本地执行迁移到远程 Worker。
