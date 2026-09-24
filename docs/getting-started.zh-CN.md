# 开发与接入

[English](getting-started.md) · **简体中文**

从 npm 安装、真实模型与存储、多轮任务及独立消费者接入，见[完整包使用教程](package-guide.zh-CN.md)；四个可运行入口见[基础示例](../examples/package-basics/README.zh-CN.md)。

## 安装与第一次运行

要求 Node.js 24+、npm 11+，`.nvmrc` 指定 Node 24。在仓库根目录执行：

```bash
nvm use
npm ci
npm run example:runtime:quickstart
npm run check
```

`npm ci` 的 prepare 构建 dist；示例命令也会先构建。check 执行严格类型检查、构建和行为测试。首次示例只执行本地 Context，不需要 `.env`、模型密钥、Redis 或数据库。完整代码为 [quickstart.ts](../examples/quickstart.ts)：

```ts
import assert from "node:assert/strict";
import { createDitto, graph } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
```
```ts
export async function quickstart() {
  const runtime = createDitto({ workers: [createContextWorker()] });
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

在已经初始化 package.json 的应用目录从 npm 安装 Ditto：

```bash
npm install @codesoul-co/ditto
# 仅在使用可选检索 Worker 时安装：
npm install @codesoul-co/ditto-retrieval
```

应用采用 ESM（package.json 设置 type=module）；TypeScript 可用 module/moduleResolution=NodeNext，target=ES2024。只从以下公开入口导入，不引用 src/dist 内部路径。业务自定义 Node 通过 [NodeContractMap 声明合并](worker-api/composition.zh-CN.md) 获得调用类型。

## 公开包入口

| Import | API |
| --- | --- |
| `@codesoul-co/ditto` | Core Runtime + Worker factories + contracts + Sandbox |
| `@codesoul-co/ditto/contracts` | NodeContract / NodeContractMap / InputOf / OutputOf / shared types |
| `@codesoul-co/ditto/worker` | defineWorker / extendWorker / defineNode / createNodeScaffold / core factories |
| `@codesoul-co/ditto/worker/node` | defineNode / NodeHandler / WorkerContext / RuntimeClient |
| `@codesoul-co/ditto/runtime` | createDitto / graph / loop / flows / config / services / transports / events / artifacts |
| `@codesoul-co/ditto/runtime/sandbox` | Sandbox / PermissionDeniedError / createLocalSandboxExecutor |
| `@codesoul-co/ditto/worker/context` | CONTEXT SDK / factory / stores / strategies / resolver |
| `@codesoul-co/ditto/worker/infer` | INFER SDK / factory / reasoning / cache / providers |
| `@codesoul-co/ditto/worker/infer/providers` | ModelProvider / ProviderRegistry / HTTP adapters |
| `@codesoul-co/ditto/worker/memory` | MEMORY SDK / factory / store and search interfaces |
| `@codesoul-co/ditto/worker/interaction` | Factory / tool and MCP registries / handlers / command and web tools |
| `@codesoul-co/ditto-retrieval` | Optional RETRIEVAL SDK / factory / embedding / retrieval providers |
| `@codesoul-co/ditto-retrieval/adapters/memory` | MEMORY ↔ RETRIEVAL adapters |
| `@codesoul-co/ditto-retrieval/adapters/context` | CONTEXT RAG ↔ RETRIEVAL adapters |

根入口不会自动导入可选 RETRIEVAL 实现。显式导入子路径后，仍需配置 Provider 并注册 Worker 才能执行；定义、类型声明和注册是不同步骤。

## 配置与接入顺序

1. 定义 Graph 的语义节点、依赖和 bind；需要重复执行时用 Loop 指定状态更新和停止条件。
2. 选择 Worker 实现：模型 Provider、MemoryStore/search、ContextStateStore、Tool/MCP/OutputSink。
3. 显式读取根目录 ditto.yaml 的行为参数和环境变量，创建 Runtime services，注册 Worker。
4. 调用 invoke、run 或 loop；检查对应结果类型，使用 finally 关闭 Runtime 和应用拥有的 SDK。

`createDitto()` 默认不读取 process.env 或 YAML。`loadRuntimeConfigFile("ditto.yaml", process.env)` 读取 YAML 和传入环境；Node `--env-file=.env` 或应用 loader 才负责读取 .env。只在需要外部连接时复制 .env.example 并填写；统一参数与分组见 [configuration](worker-api/configuration.zh-CN.md)。Worker 专项配置需按文档显式传入工厂，示例中的 Context policy 就是如此。

根入口还导出 `NODE_API_VERSION`（当前为 `2.0-rc.1`），可用于日志中的契约版本标识；它不执行协议协商。`Infer` 是仅类型命名空间，运行时工厂仍使用 createInfer/createInferWorker。

```ts
import { NODE_API_VERSION } from "@codesoul-co/ditto";
console.log(NODE_API_VERSION);
```

## 下一步

| 用途 | 文档与可运行调用 |
| --- | --- |
| 多轮 Agent，真实工具与输出 | [Graph + Loop + Worker](worker-api/examples/graph-loop-worker.ts)：`npm run example:agent` |
| 自定义节点、私有 Graph、副本资源、事件、Artifact | [组合 API](worker-api/composition.zh-CN.md)：`npm run example:runtime:api` |
| RAG / Skill / Tool / MCP / ReAct | [流程 API](worker-api/flows.zh-CN.md)：`npm run example:runtime:flows` |
| Graph/Loop、独立 Sandbox、同机/跨机通信 | [Runtime](worker-api/runtime.zh-CN.md)：`npm run example:runtime:placement` |
| Context Redis、Memory SQL/Milvus、独立 Retrieval | [数据库示例](worker-api/examples/integrations/README.zh-CN.md) |
| 全部 Worker、Provider 和具体 API | [API 索引](worker-api/README.zh-CN.md) |
