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
- `INFER.CACHE.*`：推理缓存的 `LOOKUP`、`WRITE`、`INVALIDATE`；
- `CONTEXT.*`：当前 invocation/turn 的 working set，包括任务知识 RAG 与本轮激活的 Skill；
- `MEMORY.*`：长期记忆存储与搜索，提供 GET / QUERY / SEARCH / WRITE / UPDATE / DELETE；
- `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`：对外动作；
- `INTERACTION.OBSERVE` / `INTERACTION.OUTPUT`：标准化观察与最终输出。

`INFER/PROVIDERS` 是实现目录，不是 Node。`INFER/REASONING` 同样是源码目录，不存在 `REASONING` Node。工具通过 `createInteractionWorker({ tools, mcp, output })` 注入；具体工具名与 Linux 命令不产生额外 Node Type。

RETRIEVAL 是可选的独立检索执行 Worker，仅提供 `RETRIEVAL.SEARCH`。按需从 `@ditto/core/worker/retrieval` 导入并注册；Core 默认不加载它。普通 MEMORY/CONTEXT 的直接 Provider 接入不变。见 [RETRIEVAL API](docs/worker-api/retrieval.zh-CN.md)。

## Runtime 预定义流程

四类公开组合直接位于 `src/runtime/graph.ts`，并由 `@ditto/core/runtime` 导出：

```text
runRagFlow          CONTEXT.SELECT (rag strategy)
runSkillFlow        CONTEXT.LOAD -> CONTEXT.UPDATE (when context is supplied)
runToolCallFlow      INTERACTION.ACT.TOOL   -> INTERACTION.OBSERVE -> CONTEXT.UPDATE
runMcpFlow           INTERACTION.ACT.MCP    -> INTERACTION.OBSERVE -> CONTEXT.UPDATE (invoke)
```

这些 Runtime 函数使用显式 Context。RAG 是 SELECT 的内部策略，Skill 内容由应用解析后经 LOAD/UPDATE 加入工作集。缓存调用、Redis 接入和详细示例见 [CONTEXT API](docs/worker-api/context.zh-CN.md)。

```ts
import { runRagFlow, runToolCallFlow } from "@ditto/core/runtime";

const retrieved = await runRagFlow(runtime, {
  context: { items: [] },
  query: "查找相关 API 定义",
  corpus: { uri: "urn:contracts" }, // Resolved by the configured ragStrategy.
});

const toolResult = await runToolCallFlow(runtime, {
  context: retrieved.context,
  call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
});
```

## Graph 与 Worker

Graph 只包含语义 Node Type 与数据绑定，不包含 Worker ID 或网络地址：

```ts
import { randomUUID } from "node:crypto";
import { graph, type Message } from "@ditto/core";

const review = graph<Message>("review")
  .node("memories", "MEMORY.GET", [], () => ({
    keys: ["review-policy"],
  }))
  .node("context", "CONTEXT.LOAD", ["memories"], (query, { memories }) => {
    if (memories.status !== "success" || !memories.output) throw new Error("Memory read failed");
    return { sources: [query, ...memories.output.map(memory => ({
      id: memory.id, content: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    }))] };
  })
  .node("reason", "INFER.REASONING.TRAJECTORY", ["context"], (_query, { context }) => ({
    messages: [{ role: _query.role, content: typeof _query.content === "string"
      ? _query.content : JSON.stringify(_query.content) }],
    context: context.items.map(item => ({ id: item.id, content: item.content })),
    model: { model: "your-model-name" },
    strategy: { name: "cot" },
  }))
  .node("output", "INTERACTION.OUTPUT", ["reason"], (_query, { reason }) => {
    if (reason.status !== "success" || reason.output?.status !== "completed") {
      throw new Error(reason.error?.message ?? "Trajectory incomplete");
    }
    return { deliveryId: randomUUID(), message: { role: reason.output.result.role,
      content: typeof reason.output.result.content === "string"
        ? reason.output.result.content : JSON.stringify(reason.output.result.content) } };
  });
```

注册更多 Worker 副本即可扩容，不需要改变 Graph。同一套契约可用于单进程、多 Worker、多进程或自定义远程传输。

详细 INFER 接入与七个叶子接口见 [Worker API](docs/worker-api/infer.zh-CN.md)。

按 Graph → Loop → Worker 定义 Agent，完整示例见 [graph-loop-worker.ts](examples/graph-loop-worker.ts)，运行 `npm run example:agent`。工具与 MCP 接入见 [Interaction API](docs/interaction-runtime.zh-CN.md#graphloop-与-worker-使用入口)。

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
    │   ├── reasoning/            # 推理叶子实现与节点骨架
    │   ├── cache/                # LOOKUP / WRITE / INVALIDATE
    │   └── providers/            # 统一 Provider 注册和供应商协议
    ├── context/
    ├── memory/
    ├── retrieval/                # optional SEARCH worker; explicit subpath import
    └── interaction/act/tool/     # Tool Node、注册表与实现目录
```

Core 的第三方运行时依赖仅有 `yaml` 解析器。重型 RPC、事件总线、MCP SDK、数据库驱动与模型 SDK 保持为可选的应用/适配器选择。

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

行为参数统一放根目录 [`ditto.yaml`](ditto.yaml)，凭证与部署配置使用 [`.env.example`](.env.example)，所有 Worker 共用 Runtime services。详见 [统一配置 API](docs/worker-api/configuration.zh-CN.md)。运行方式见 [INFER 示例指南](examples/README.zh-CN.md#infer)。

MEMORY 的接入、插件边界、六个节点和配置详见 [MEMORY API](docs/worker-api/memory.zh-CN.md)。
