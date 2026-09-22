# 开发与接入

[English](getting-started.md) · **简体中文**

## 安装与第一次运行

要求 Node.js 24+、npm 11+，`.nvmrc` 指定 Node 24。在仓库根目录执行：

```bash
nvm use
npm ci
npm run example:runtime:quickstart
npm run check
```

`npm ci` 的 prepare 构建 dist；示例命令也会先构建。check 执行严格类型检查、构建和行为测试。首次示例只执行本地 Context，不需要 `.env`、模型密钥、Redis 或数据库。完整代码为 [quickstart.ts](../examples/runtime/quickstart.ts)：

```ts
import assert from "node:assert/strict";
import { createDitto, graph, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
```
```ts
export async function quickstart() {
  const config = loadRuntimeConfigFile("ditto.yaml", {});
  const runtime = createDitto({ config, workers: [createContextWorker({ policy: config.context.policy ?? {} })] });
  const plan = graph<string>("first-context")
    .node("loaded", "CONTEXT.LOAD", [], text => ({ sources: [{ role: "user", content: text }] }))
    .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
      context: loaded, purpose: "infer", limit: 1,
    }));
  try {
    const output = await runtime.run(plan, "Hello Ditto", { concurrency: 2 });
    assert.equal(output.selected.context.items[0]?.content, "Hello Ditto");
    return output.selected;
  } finally { await runtime.close(); }
}
```

返回 ContextSelection，包含 purpose、context、selectedItemIds。SELECT 不直接返回 messages；接模型时按 [Context API](worker-api/context.zh-CN.md) 映射。这个调用使用显式 Context；缓存模式需要注入 Redis 或其他 ContextStateStore 并使用 scope。

## 外部项目引用

包名 `@ditto/core`，当前 private，未发布 npm。在已经初始化 package.json 的应用目录使用本地依赖：

```bash
npm install /absolute/path/to/Ditto
```

先在 Ditto 仓库运行 npm ci/build。应用采用 ESM（package.json 设置 type=module）；TypeScript 可用 module/moduleResolution=NodeNext，target=ES2024。只从以下公开入口导入，不引用 src/dist 内部路径。业务自定义 Node 通过 [NodeContractMap 声明合并](worker-api/composition.zh-CN.md) 获得调用类型。

## 公开包入口

| Import | API |
| --- | --- |
| `@ditto/core` | Core Runtime + Worker factories + contracts + Sandbox |
| `@ditto/core/contracts` | NodeContract / NodeContractMap / InputOf / OutputOf / shared types |
| `@ditto/core/worker` | defineWorker / extendWorker / defineNode / createNodeScaffold / core factories |
| `@ditto/core/worker/node` | defineNode / NodeHandler / WorkerContext / RuntimeClient |
| `@ditto/core/runtime` | createDitto / graph / loop / flows / config / services / transports / events / artifacts |
| `@ditto/core/runtime/sandbox` | Sandbox / PermissionDeniedError / createLocalSandboxExecutor |
| `@ditto/core/worker/context` | CONTEXT SDK / factory / stores / strategies / resolver |
| `@ditto/core/worker/infer` | INFER SDK / factory / reasoning / cache / providers |
| `@ditto/core/worker/infer/providers` | ModelProvider / ProviderRegistry / HTTP adapters |
| `@ditto/core/worker/memory` | MEMORY SDK / factory / store and search interfaces |
| `@ditto/core/worker/interaction` | Factory / tool and MCP registries / handlers / command and web tools |
| `@ditto/core/worker/retrieval` | Optional RETRIEVAL SDK / factory / embedding / retrieval providers |
| `@ditto/core/worker/retrieval/adapters/memory` | MEMORY ↔ RETRIEVAL adapters |
| `@ditto/core/worker/retrieval/adapters/context` | CONTEXT RAG ↔ RETRIEVAL adapters |

根入口不会自动导入可选 RETRIEVAL 实现。显式导入子路径后，仍需配置 Provider 并注册 Worker 才能执行；定义、类型声明和注册是不同步骤。

## 配置与接入顺序

1. 定义 Graph 的语义节点、依赖和 bind；需要重复执行时用 Loop 指定状态更新和停止条件。
2. 选择 Worker 实现：模型 Provider、MemoryStore/search、ContextStateStore、Tool/MCP/OutputSink。
3. 显式读取根目录 ditto.yaml 的行为参数和环境变量，创建 Runtime services，注册 Worker。
4. 调用 invoke、run 或 loop；检查对应结果类型，使用 finally 关闭 Runtime 和应用拥有的 SDK。

`createDitto()` 默认不读取 process.env 或 YAML。`loadRuntimeConfigFile("ditto.yaml", process.env)` 读取 YAML 和传入环境；Node `--env-file=.env` 或应用 loader 才负责读取 .env。只在需要外部连接时复制 .env.example 并填写；统一参数与分组见 [configuration](worker-api/configuration.zh-CN.md)。Worker 专项配置需按文档显式传入工厂，示例中的 Context policy 就是如此。

根入口还导出 `NODE_API_VERSION`（当前为 `2.0-rc.1`），可用于日志中的契约版本标识；它不执行协议协商。`Infer` 是仅类型命名空间，运行时工厂仍使用 createInfer/createInferWorker。

```ts
import { NODE_API_VERSION } from "@ditto/core";
console.log(NODE_API_VERSION);
```

## 下一步

| 用途 | 文档与可运行调用 |
| --- | --- |
| 多轮 Agent，真实工具与输出 | [Graph + Loop + Worker](../examples/graph-loop-worker.ts)：`npm run example:agent` |
| 自定义节点、私有 Graph、副本资源、事件、Artifact | [组合 API](worker-api/composition.zh-CN.md)：`npm run example:runtime:api` |
| RAG / Skill / Tool / MCP / ReAct | [流程 API](worker-api/flows.zh-CN.md)：`npm run example:runtime:flows` |
| Graph/Loop、独立 Sandbox、同机/跨机通信 | [Runtime](worker-api/runtime.zh-CN.md)：`npm run example:runtime:placement` |
| Context Redis、Memory SQL/Milvus、独立 Retrieval | [数据库示例](../examples/worker/README.zh-CN.md) |
| 全部 Worker、Provider 和具体 API | [API 索引](worker-api/README.zh-CN.md) |
