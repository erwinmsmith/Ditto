# 开发与接入

## 环境与检查

使用 Node.js 24+、npm 11+，`.nvmrc` 固定主版本 24。项目没有第三方运行时依赖；TypeScript 与 Node 类型仅用于开发。

```bash
nvm use
npm ci
npm run check
```

`check` 执行严格类型检查、行为测试和构建，CI 执行相同检查。`dist/` 是公开包的编译输出，包目前 private，未发布至 npm。

## 配置与后续示例

复制 `.env.example` 为 `.env`，按 [Agent 与运行配置](interaction-runtime.md) 设置 Provider、模型、Key 和权限。库本身不会隐式加载环境文件；由应用启动代码显式加载并调用 `loadRuntimeConfig()`。

运行 `npm run build && node examples/worker-graph.ts` 可验证 Memory → Context → Reasoning → Interaction 的本地链路。示例使用确定性 handler，不访问模型或数据库；包仍未发布，通过仓库内 npm 自引用验证包入口。

公开入口：`@ditto/core`、`contracts`、`worker`、`worker/node`、`worker/memory`、`worker/context`、`worker/reasoning`、`worker/reasoning/providers`、`worker/interaction`、`runtime`、`runtime/sandbox`。不保留顶层 `node` / `agent` / `providers` / `sandbox` 旧入口；根入口仍提供通用导出。

内置或已声明扩展的命名空间可用短操作名初始化：

```ts
import { extendWorker } from "@ditto/core/worker";
const memory = extendWorker("MEMORY", {
  nodes: { RETRIEVE: async (_input) => [] },
});
```

此处空结果仅演示契约；实际检索逻辑与数据库连接由 Memory Worker 的资源和 handler 提供。`extendWorker` 创建新定义，不自动补齐其余操作，也不修改已部署 Worker。

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
      "SEARCH.QUERY",
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

组合 Worker 内部 Graph 使用 `ctx.run`；跨 Worker 调用使用 `ctx.invoke`。两者的示例和语义见 [架构](architecture.md)。
