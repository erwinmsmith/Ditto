# 开发与接入

[English](getting-started.md) · **简体中文**

## 环境与检查

使用 Node.js 24+、npm 11+，`.nvmrc` 固定主版本 24。项目的第三方运行时依赖仅有 `yaml` 解析器；TypeScript 与 Node 类型仅用于开发。

```bash
nvm use
npm ci
npm run check
```

`check` 执行严格类型检查、行为测试和构建，CI 执行相同检查。`dist/` 是公开包的编译输出，包目前 private，未发布至 npm。

## 配置与后续示例

复制 `.env.example` 为 `.env`，按 [Agent 与运行配置](interaction-runtime.zh-CN.md) 设置 Provider、模型、Key 和权限。库本身不会隐式加载环境文件；由应用启动代码显式加载并调用 `loadRuntimeConfigFile("ditto.yaml", process.env)`。

完整的 [Graph + Loop + Worker 示例](../examples/graph-loop-worker.ts)通过包入口运行，执行 `npm run example:agent` 即可。示例读取本地文件并输出观察结果，无需模型或数据库配置。包目前尚未发布。

公开入口：`@ditto/core`、`contracts`、`worker`、`worker/node`、`worker/memory`、`worker/context`、`worker/infer`、`worker/infer/providers`、`worker/interaction`、`runtime`、`runtime/sandbox`。不保留顶层 `node` / `agent` / `providers` / `presets` / `sandbox` 旧入口；根入口仍提供通用导出，包括四个 Runtime 流程函数。

内置或已声明扩展的命名空间可用短操作名初始化：

```ts
import { extendWorker } from "@ditto/core/worker";
const memory = extendWorker("MEMORY", {
  nodes: { RETRIEVE: async (_input) => [] },
});
```

此处空结果仅演示契约；实际检索逻辑与数据库连接由 Memory Worker 的资源和 handler 提供。`extendWorker` 创建新定义，不自动补齐其余操作，也不修改已部署 Worker。

## 创建 Node 与 Worker 副本

`defineNode(workerType, nodeType, handler)` 创建不可变的 `{ workerType, type, execute }` 定义，第一个参数必填。例如 `defineNode("MEMORY", "MEMORY.GET", handler)` 声明该 Node 归属 MEMORY Worker 类型。将它挂到其他类型的 Worker，会在定义阶段、创建资源之前报错。原有两个参数的写法不再支持。

直接写在 `Worker.nodes` 中的函数会自动绑定当前 Worker。Node 的语义名称与所属 Worker 的部署角色仍然独立：自定义的 `assistant` Worker 可以显式拥有一个 REASONING Node。归属必须匹配实际挂载它的 Worker，不要求匹配 Node 名称的前缀。

创建 Worker 分为两步：

1. `defineWorker({ type, nodes, ... })`，或使用短操作名的 `extendWorker(type, { nodes, ... })`，创建 Worker 定义。定义必须至少包含一个已实现 Node，并公开至少一个已实现入口。
2. `runtime.register(worker)` 创建副本及其资源；再次注册得到独立副本，使用返回 handle 的 `close()` 等待执行收尾并释放资源。

定义 Node 或 Worker 不会自动注册。Runtime 执行始终经过已注册 Worker，内部 Graph 也绑定当前 Worker；没有独立注册 Node 的入口。归属以 Worker 类型为单位，同类型的多个副本可以使用同一份不可变定义。这是 API 组合约束，不是对直接调用 JavaScript 函数的操作系统隔离。

新增语义 Node 时，在 NodeContractMap 声明输入输出并提供 handler。下面创建一个自定义 Worker，包含新的 SEARCH.QUERY Node：

## 自定义 Worker 和 Node

```ts
import { createDitto, defineWorker, defineNode, type NodeContract } from "@ditto/core";

declare module "@ditto/core/contracts" {
  interface NodeContractMap {
    "SEARCH.QUERY": NodeContract<{ query: string }, readonly { title: string }[]>;
  }
}

const search = defineWorker({
  type: "research-assistant",
  concurrency: 4,
  expose: ["SEARCH.QUERY"],
  resources: () => ({ queries: 0 }),
  nodes: {
    "SEARCH.QUERY": defineNode<"SEARCH.QUERY", { queries: number }>(
      "research-assistant", "SEARCH.QUERY",
      async (input, ctx) => {
        ctx.resources.queries++;
        return [{ title: input.query }];
      },
    ),
  },
});

const runtime = createDitto({ workers: [search] });
try {
  runtime.register(search); // 新副本、新资源
  console.log(await runtime.invoke("SEARCH.QUERY", { query: "hello" }));
} finally {
  await runtime.close();
}
```

增加 Node 通过声明合并和 handler 完成；更换模型通过 Provider/模型配置完成。不要在固定业务输入里添加 Key、host、transport 或 sandbox 字段。

组合 Worker 内部 Graph 使用 `ctx.run`；跨 Worker 调用使用 `ctx.invoke`。两者的示例和语义见 [架构](architecture.zh-CN.md)。

行为参数统一放根目录 `ditto.yaml`；配置字段与覆盖顺序见 [统一配置 API](worker-api/configuration.zh-CN.md)。
