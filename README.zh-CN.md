<p align="center">
  <img src="./logo_project.png" alt="Ditto logo" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  面向可组合 Agent 系统的轻量 Node-native Runtime。<br />
  扩容 Worker，无需改变 Graph 与 Node Contract。
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

> 权威定义见[节点体系与 API Contract](docs/13-node-api-contract.zh-CN.md)，其中包含最终节点树、语义边界、固定公共类型，以及所有公共 Node 的输入输出契约。

## 架构定位

Ditto 将系统拆分为四个概念：

- **Node**：最小的可路由语义操作；
- **Worker**：实现、资源、部署与扩容边界；
- **Execution Graph**：与执行位置无关的 Node 组合；
- **Runtime**：负责调度、路由、通信与执行。

更换模型、数据库、工具 Provider、部署位置或副本数不会产生新的 Node Type。Runtime 内部以 `invoke` 表示请求/响应，以 `emit` 表示异步事件；二者都不是 Interaction Node。

## 最终能力域

- `INFER.REASONING.*`：显式推理组织能力，包括 `TRAJECTORY`、`REFLECT`、`DELIBERATE`、`SAMPLE`；
- `INFER.CACHE`：保留的命名空间骨架；
- `CONTEXT.*`：当前 invocation/turn 的 working set，包括任务知识 RAG 与本轮激活的 Skill；
- `MEMORY.*`：跨 invocation 持久存在的语义状态，包括 Memory RAG 与持久化 Skill；
- `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`：对外动作；
- `INTERACTION.OBSERVE` / `INTERACTION.OUTPUT`：标准化观察与最终输出。

`INFER/PROVIDERS` 是实现目录，不是 Node。`INFER/REASONING` 同样是源码目录，不存在 `REASONING` Node。工具实现位于 `interaction/act/tool/` 下，`linux-commands/` 文件夹存放注册工具名，不产生额外 Node Type。

## Runtime 预定义流程

四类公开组合直接位于 `src/runtime/graph.ts`，并由 `@ditto/core/runtime` 导出：

```text
runRagFlow(context)  CONTEXT.RAG.RETRIEVE -> CONTEXT.RAG.RANK -> CONTEXT.UPDATE
runRagFlow(memory)   MEMORY.RAG.RETRIEVE  -> MEMORY.RAG.RANK  -> CONTEXT.UPDATE
runSkillFlow         MEMORY.SKILL          -> CONTEXT.UPDATE
runToolCallFlow      INTERACTION.ACT.TOOL   -> CONTEXT.UPDATE
runMcpFlow           INTERACTION.ACT.MCP    -> CONTEXT.UPDATE
```

它们是函数，不是 Node。它们为 `CONTEXT.UPDATE` 提供统一入口，应用仍可自由组合相同的叶子 Node。RAG 的 `EMBED` 属于索引准备，因此不进入查询时流程。

```ts
import { runRagFlow, runToolCallFlow } from "@ditto/core/runtime";

const retrieved = await runRagFlow(runtime, {
  scope: "context",
  context: { items: [] },
  query: "查找相关 API 定义",
  corpus: [{ id: "contract", content: "..." }],
});

const toolResult = await runToolCallFlow(runtime, {
  context: retrieved.context,
  call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
});
```

## Graph 与 Worker

Graph 只包含语义 Node Type 与数据绑定，不包含 Worker ID 或网络地址：

```ts
import { graph, type Message } from "@ditto/core";

const review = graph<Message>("review")
  .node("memories", "MEMORY.RETRIEVE", [], () => ({
    selector: { keys: ["review-policy"] },
  }))
  .node("context", "CONTEXT.LOAD", ["memories"], (query, { memories }) => ({
    sources: [query, ...memories.map((memory) => memory.message)],
  }))
  .node("reason", "INFER.REASONING.TRAJECTORY", ["context"], (_query, { context }) => ({
    input: { messages: [], context },
    strategy: "CoT",
  }))
  .node("output", "INTERACTION.OUTPUT", ["reason"], (_query, { reason }) => ({
    message: reason.result.message,
  }));
```

注册更多 Worker 副本即可扩容，不需要改变 Graph。同一套契约可用于单进程、多 Worker、多进程或自定义远程传输。

## 仓库结构

```text
src/
├── contracts/                    # 固定公共类型与开放式 NodeContractMap
├── runtime/
│   ├── graph.ts                  # DAG 与四类预定义流程
│   ├── runtime.ts                # 路由与生命周期
│   └── communication/            # invoke/emit、传输与 Artifact
└── worker/
    ├── infer/
    │   ├── reasoning/            # 叶子 Node 骨架
    │   ├── cache/                # 保留命名空间骨架
    │   └── providers/            # 扁平 Provider 适配边界
    ├── context/
    ├── memory/
    └── interaction/act/tool/     # Tool Node、注册表与实现目录
```

Core 没有第三方运行时依赖。重型 RPC、事件总线、MCP SDK、数据库驱动与模型 SDK 保持为可选的应用/适配器选择。

## 开发

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

当前 package 为 private，暂不发布 npm。其他实验仓库可通过本地 Git 或 workspace dependency 使用；现有 package exports 可在后续 npm 发布时继续沿用。

## 文档

- [节点体系与 API Contract](docs/13-node-api-contract.zh-CN.md)
- [架构与扩展边界](docs/architecture.zh-CN.md)
- [开发与 package 集成](docs/getting-started.zh-CN.md)
- [Worker 通信与部署](docs/worker-communication.zh-CN.md)
- [Provider、Interaction 与预定义流程](docs/interaction-runtime.zh-CN.md)

具体使用案例、缺陷与架构讨论请提交至 [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues)。
