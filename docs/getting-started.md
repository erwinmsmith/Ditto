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

复制 `.env.example` 为 `.env`，按 [Agent 与运行配置](agent-runtime.md) 设置 Provider、模型、Key 和权限。库本身不会隐式加载环境文件；由应用启动代码显式加载并调用 `loadRuntimeConfig()`。

`examples/` 当前仅保留空目录占位。后续用于展示通过发布后的 npm 包构建不同 Agent 的完整例子，现在不提供可运行的示例工程。下面是 API 使用片段，包目前尚未发布。

公开入口：`@ditto/core` 及 `contracts`、`node`、`worker`、`runtime`、`providers`、`sandbox`、`agent` 子入口。`node` 和 `worker` 直接指向单文件模块，不提供 `nodes` 空类兼容入口。

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
