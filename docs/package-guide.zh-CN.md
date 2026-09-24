# npm 包基础使用指南

[English](package-guide.md) · [API 参考](worker-api/README.zh-CN.md) · [可运行入门示例](../examples/package-basics/README.zh-CN.md)

本指南从空目录安装开始，说明如何配置 Worker、执行 Graph、用 Loop 组合多个阶段、连接真实模型与存储，以及将仓库中的完整场景接入自己的应用。示例只使用 npm 公开入口。

## 1. 选择要安装的包

| 包 | 包含内容 | 何时安装 |
| --- | --- | --- |
| `@codesoul-co/ditto` | Runtime、Graph、Loop、INFER、CONTEXT、MEMORY、INTERACTION、公开类型和 Sandbox | 所有 Ditto 应用 |
| `@codesoul-co/ditto-retrieval` | RETRIEVAL.SEARCH、检索 Provider、Memory/Context 检索转接器 | 需要这些检索实现时额外安装 |

两个包独立发布。检索包通过 peer dependency 复用主包，主包不会自动安装或启动检索 Worker。数据库驱动、Redis SDK、浏览器工具等由应用按需安装。

`@codesoul-co/ditto/runtime` 是主包的公开子入口；它不是另一个要安装的 npm 包。`@ditto/core`、`ditto`、`ditto/core` 和主包的 `/worker/retrieval` 都不是本指南使用的发布入口。

```sh
mkdir ditto-demo
cd ditto-demo
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
# 可选；只有需要检索包的代码才需要这一项。
npm install @codesoul-co/ditto-retrieval
```

使用 Node.js 24+、npm 11+。包使用 ESM，提供 JavaScript 与 TypeScript 声明；不提供 CommonJS `require()` 构建。Runtime 面向 Node，不是浏览器 SDK。只使用 JavaScript 时不必安装 TypeScript。

## 2. 五分钟内完成第一次调用

创建 `app.mjs`：

```js
import { createDitto, createContextWorker, graph } from "@codesoul-co/ditto";

const runtime = createDitto({ workers: [createContextWorker()] });
const plan = graph("first-context")
  .node("loaded", "CONTEXT.LOAD", [], text => ({
    sources: [{ role: "user", content: text }],
  }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
    context: loaded,
    purpose: "infer",
    limit: 1,
  }));

try {
  const result = await runtime.run(plan, "Hello Ditto");
  console.log(result.selected.context.items[0].content);
} finally {
  await runtime.close();
}
```

```sh
node app.mjs
# Hello Ditto
```

这段程序执行真实的 CONTEXT.LOAD → CONTEXT.SELECT。`loaded`、`selected` 是图中节点的本地 ID；第二步通过依赖声明得到第一步输出。它是无外部服务的 API 入门，不是带持久化记忆的完整 Agent。

`createDitto()` 不会自动注册所有 Worker，也不会隐式读取当前目录下的 YAML 或 `.env`。第一次调用不需要这些文件。

## 3. TypeScript 的运行和类型检查

```sh
npm install --save-dev typescript @types/node
```

推荐消费者配置 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "types": ["node"],
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["app.ts", "examples/**/*.ts"],
  "exclude": ["examples/package-basics/retrieval.ts"]
}
```

主包单独使用时，上面的 exclude 排除尚未安装的可选检索示例；安装检索包后删除这一项。消费者不需要 `paths`、源码链接或 Ditto 仓库的 tsconfig。

Node 24 可以直接运行本教程使用的可擦除类型语法：`node app.ts`；类型错误仍需通过 `npx tsc -p tsconfig.json` 检查。生产项目也可以自行编译，确保运行时相对导入后缀与生成文件一致。

## 4. 四个组成部分如何对应

| 概念 | 职责 | 应用中的位置 |
| --- | --- | --- |
| Node | 定义一次语义操作及输入输出，如 `MEMORY.GET` | Graph 内声明 |
| Worker | 实现 Node，并拥有执行资源、并发与部署边界 | 应用启动时显式注册 |
| Graph | 描述一个阶段内的依赖和输入绑定 | 可复用的应用模块 |
| Loop | 调度一个或多个 Graph，维护计划与停止条件 | 完整 Agent 的入口 |

Agent 的“财务角色”“研究角色”属于应用任务分工，不等同于 Worker 类型。模型、工具、数据库、部署位置发生变化时，通常只替换 Provider、适配器或 Worker 注册方式。

```ts
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
```

没有注册对应 Worker 时，声明 Graph 或导入类型不会补出执行能力。`createDitto({ workers: [...] })` 和 `runtime.register(worker)` 都是公开注册方式。

## 5. invoke、run、loop 的选择与返回值

| 调用 | 适用情况 | 返回值 |
| --- | --- | --- |
| `runtime.invoke(node, input)` | 直接调用一个 Node | 该 Node 自己的输出契约 |
| `runtime.run(graph, input)` | 执行一个 Graph | 以 Graph 节点 ID 为键的输出对象 |
| `runtime.loop(plan, input)` | 分阶段、分支、重试或循环 | 所用 Loop 定义的返回结果/最终状态 |

返回值不是统一封装。CONTEXT 直接返回 Context 或 ContextSelection；INFER、MEMORY、RETRIEVAL 返回 `NodeResult<T>`；工具返回 ExternalResult；OUTPUT 返回回执。调用成功返回不代表业务成功，必须检查具体契约。

```ts
const result = await runtime.invoke("MEMORY.GET", { keys: ["user:alice:preferences"] });
if (result.status !== "success" || result.output === undefined) {
  throw new Error(result.error?.message ?? "Memory read failed");
}
console.log(result.output); // MemoryItem[]；不是 result.output.items
```

Graph 不会替应用将每个 `NodeResult.status` 自动解释为异常。需要阻止后续步骤时，在依赖绑定或 Loop 中检查状态并抛错。CONTEXT.SELECT 返回 `selection.context.items`，不是直接可发送给模型的 messages；角色保存在 `item.metadata.role`，内容也可能不是字符串。完整示例在发送模型前显式检查并转换。

## 6. 使用 Loop 组合阶段

多个 Graph 通过 Loop 的计划组合。计划只 yield Graph，不直接执行 Worker、读写数据库或在 Graph 中嵌套另一个 Graph。

```ts
import { graphStep, loop } from "@codesoul-co/ditto/runtime";

const workflow = loop({
  id: "my-workflow",
  maxIterations: 4,
  *plan(input) {
    const loaded = yield* graphStep(loadGraph, input);
    const analyzed = yield* graphStep(analyzeGraph, loaded);
    return yield* graphStep(saveGraph, analyzed);
  },
});

const output = await runtime.loop(workflow, request, {
  concurrency: 2,
  signal: AbortSignal.timeout(120_000),
  onGraph(event) { console.log(event.graphId, event.status); },
});
```

此处 `loadGraph` 等代表应用已经定义的图；完整可运行版本见 [agent.ts](../examples/package-basics/agent.ts)。生成器形式的 `maxIterations` 限制 Graph 执行次数，失败的 Graph 也计入。固定 Graph 的 `loop({ graph, bind, update, done })` 形式则返回最终循环状态；两种形式不要混淆。

Graph 的 `concurrency` 限制同一图可同时运行的节点，不会取消依赖关系。需要精确控制工具、模型和队列资源时，另行配置 Worker 并发及执行预算。

## 7. 连接真实模型

创建 `.env`，将占位符替换为供应商提供的真实值：

```dotenv
DITTO_SHARED_PROVIDERS=primary
DITTO_SHARED_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_SHARED_PROVIDER_PRIMARY_BASE_URL=https://your-provider.example/v1
DITTO_SHARED_PROVIDER_PRIMARY_API_KEY=YOUR_API_KEY
DITTO_SHARED_PROVIDER_PRIMARY_MODEL=YOUR_MODEL_ID
DITTO_WORKER_INFER_MODEL_PROVIDER=primary
DITTO_WORKER_INFER_MODEL=YOUR_MODEL_ID
DITTO_SHARED_SANDBOX_ALLOW_NETWORK=https://your-provider.example
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
```

`primary` 是应用自己的 Provider 名，必须与默认模型的 provider 相同。`BASE_URL` 使用供应商要求的 API 根路径；网络允许列表填写 URL origin，不含 `/v1` 路径。支持的 Provider kind 为 `openai-compatible`、`anthropic`、`gemini`，供应商专用参数见 [INFER API](worker-api/infer.zh-CN.md)。

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
const config = loadRuntimeConfig(process.env, {
  runtime: { timeoutMs: 60_000 },
  workers: { context: { cache: { ttlMs: 300_000 } } },
});
```

启动时使用 `node --env-file=.env app.ts`。`loadRuntimeConfig` 解析传入环境和设置，但不读取 `.env` 文件；已有环境变量优先于 Node 加载的 env 文件。若使用 YAML，改为 `loadRuntimeConfigFile("ditto.yaml", process.env)`，配置文件由应用提供，不从已安装包的内部路径读取。

`createInferWorker()` 复用 Runtime 的 Provider 配置。完整 Agent 在 Graph 中调用 `INFER.REASONING.SAMPLE`，并检查返回的 `status`、`output.message.content`；只调用模型不等于完成整个任务。

## 8. Redis Context 与数据库 Memory

```sh
npm install redis@6.2.1
# 在单独的终端启动本地开发 Redis；已有服务时直接配置连接地址。
redis-server --bind 127.0.0.1 --port 6379
```

Context 是短期工作集，示例使用真实 Redis、TTL 和 scope。Memory 是长期会话记录，示例通过 MEMORY Worker 存入文件 SQLite。业务订单、审批单、产物账本不是 Memory 的替代品。Redis 和数据库客户端的创建、连接与关闭由应用负责。

本教程复用以下应用适配器：

| 文件 | 作用 |
| --- | --- |
| `examples/_shared/tools/storage/redis-context.ts` | 连接 Redis SDK，供 Context Worker 使用 |
| `sqlite-memory.ts` | 打开文件 SQLite，创建 Memory 表，配置事务和 WAL |
| `sql-memory.ts` | 实现公开 MemoryStore 与搜索接口 |
| `workers.ts` | 将 Redis 与 SQLite 注入对应 Worker，提供统一关闭方法 |

这些文件不是 npm 主包导出的业务方法，复制示例时必须一并带上。Node SQLite 不需要另装数据库驱动；`ExperimentalWarning` 是 Node 的提示，应用仍应处理真正的数据库错误。

带 `scope` 的 `CONTEXT.LOAD` 在没有 `sources` 时读取缓存；带 `sources` 时初始化/替换该 scope 的上下文。缓存过期由应用决定从何处恢复。入门 Agent 每轮从 Memory 重建上下文，因此不依赖 Redis 永久保留历史；Redis 连接错误仍会使任务失败，不会静默退回内存。

使用 PostgreSQL、MySQL 或向量数据库时，按公开 MemoryStore/MemorySearchProvider 接入并进行对应数据库验收。已有 [存储指南](../examples/_shared/tools/storage/README.zh-CN.md) 和 [记忆能力示例](../examples/capabilities/memory/README.zh-CN.md) 包含适配位置；SQLite 验收不代表这些数据库都已在同一环境中验证。

## 9. 运行完整多轮 Agent

入门 Agent 的流程为：

```text
MEMORY.GET → 检查最近一轮是否已完成
  ├─ 已完成：重新输出已保存答案
  └─ 新请求：CONTEXT.LOAD → SELECT → INFER.SAMPLE → CONTEXT.UPDATE
             → MEMORY.WRITE 或 UPDATE → INTERACTION.OUTPUT → 答案文件
```

所有阶段都由一次 `runtime.loop(conversationPlan, ...)` 调度。Memory 在输出前提交；最近一轮输出中断时，可以用相同 session、turn、prompt 重试而不重新推理。

在仓库根目录：

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env.local
# 编辑 .env.local，填写真实模型信息。
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt '记住我的项目代号是 orchid-42。'

# 新进程继续同一会话。
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt '我的项目代号是什么？'

# 最近一轮的原样重放，返回 replayed: true。
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt '我的项目代号是什么？'
```

默认产物：`.examples-package-basics-tasks/alice/memory.sqlite` 和 `answers/turn-2.md`。CLI 返回 `answer`、`file`、`replayed`，可以直接读取答案文件复核最终结果。相同 turn 搭配不同 prompt 会被拒绝。

这是单会话串行的基础实现。可信控制器提供 session，使用新的 turn ID 表示新请求；不要并发修改同一会话，也不要在后续轮次完成后复用更早的 turn ID。它保存最近一轮的重放状态，保留最多五轮历史用于下一轮提示，不承诺任意历史任务的完整检查点恢复。多用户系统需要认证、租户隔离、会话串行化及输出适配器的业务幂等策略；长任务恢复使用 [4.16 示例](../examples/patterns/long-running/README.zh-CN.md)。

## 10. 在自己的 npm 项目中复用这些文件

主包不包含仓库的 `examples` 目录或第三方业务工具。可以在相邻目录保留源码仓库作为示例来源，然后复制应用文件，运行时依然只从 npm 包调用框架：

```sh
# 在 ditto-demo 目录中执行；../Ditto 是示例仓库的位置。
mkdir -p examples/_shared/tools/storage/dependencies
cp -R ../Ditto/examples/package-basics examples/
cp ../Ditto/examples/_shared/tools/package-basics.ts examples/_shared/tools/
cp ../Ditto/examples/_shared/tools/storage/{workers,redis-context,sqlite-memory,sql-memory}.ts examples/_shared/tools/storage/
cp ../Ditto/examples/_shared/tools/storage/dependencies/package.json examples/_shared/tools/storage/dependencies/
npm install @codesoul-co/ditto redis@6.2.1
cp examples/package-basics/.env.example .env
# 编辑 .env，然后执行上面的 agent.ts 命令。
```

保留这些相对路径，Redis SDK 可以从消费者根目录的 `node_modules` 解析。不需要复制整个框架 `src`、`dist`、根 `package.json`、仓库测试脚本或本地凭据。

只运行 `context.ts` / `tools.ts` 时只需主包；运行 `retrieval.ts` 时再安装独立检索包。不要从自己的新项目直接执行仓库的 `npm run example:*` 名称，除非已经在应用 package.json 中定义了这些 scripts。

## 11. 接入可选检索包

```sh
npm install @codesoul-co/ditto-retrieval
node examples/package-basics/retrieval.ts Redis
```

返回命中的 `context` 文档及 `guide.md#context` 来源。这个 Provider 使用应用中的两条演示文档做关键词过滤，展示接线方式；它不创建数据库、向量索引，也不声称实现了向量检索。

```ts
import { createRetrievalWorker, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";
import { createRetrievalContextStrategy } from "@codesoul-co/ditto-retrieval/adapters/context";
```

在 Registry 中明确绑定允许访问的 target 和 strategy，再注册 Retrieval Worker。数据库全文搜索、向量查询、embedding 和 rerank 的接入见 [检索 Provider API](worker-api/retrieval-providers.zh-CN.md)。Graph 负责检索和后续业务步骤；完整 RAG 的筛选、上下文、生成与来源验证见 [4.1 RAG](../examples/patterns/rag-qa/README.zh-CN.md)。内部知识从经审核的 Memory 记录读取；企业外部知识库经独立 Provider 接入，两者要分别配置权限和数据范围。

## 12. 将现有执行模式接入业务

| 需求 | 推荐起点 | 需要替换的应用部分 |
| --- | --- | --- |
| 文档问答、企业知识助手 | [RAG](../examples/patterns/rag-qa/README.zh-CN.md) | 请求身份、资料目录、访问控制、模型与输出 |
| 联网问答 | [Web search](../examples/patterns/web-search-qa/README.zh-CN.md) | 搜索供应商、允许域名、网页工具 |
| 复杂研究 | [Research](../examples/patterns/deep-research/README.zh-CN.md) | 子问题、证据库、预算、报告出口 |
| 工具链与业务写入 | [Tool chain](../examples/patterns/tool-chain/README.zh-CN.md) | CRM/API 适配器、身份、幂等键 |
| 人工审批 | [Human-in-the-loop](../examples/patterns/human-in-the-loop/README.zh-CN.md) | 可信审批控制器、编辑输入、发布适配器 |
| 多 Agent 调度 | [模式索引](../examples/patterns/README.zh-CN.md) | 专业角色、职责移交和路由策略 |
| 中断恢复 | [Long-running](../examples/patterns/long-running/README.zh-CN.md) | 检查点存储、业务副作用核对和恢复控制器 |

先阅读所选模式 README 中的请求格式、信任边界、依赖安装、CLI、程序调用、失败分支和验收命令，再复制目录及其相对应用依赖。示例中的 `runRag`、`runAgent` 等是应用入口，不是新增的 Ditto npm 业务 API。

## 13. 常见问题

| 表现 | 检查方式 |
| --- | --- |
| Cannot find package | 核对完整 scope、运行目录的 package.json，以及是否安装可选检索包 |
| Package subpath is not exported | 使用文档里的公开入口；不要导入包内 `src`、`dist` 或旧 `/worker/retrieval` |
| 没有可用 Worker | 导入不会自动注册 Worker；检查 runtime 的 workers/register 调用 |
| 模型 Provider 未配置 | 检查 `.env` 是否实际加载、provider 名是否一致、模型 ID 是否真实存在 |
| 网络权限失败 | 核对 Sandbox 的 origin 允许列表、供应商 API 根 URL |
| Context state store unavailable | 带 scope 的调用需要显式 Redis/stateStore 配置 |
| Context not found | scope 不一致或 TTL 到期；从长期 Memory 重建工作集 |
| Redis connection refused | 启动 Redis 或修正连接地址；不应把此错误改成内存回退 |
| Memory key conflicts | 新内容更新已有记录应使用 MEMORY.UPDATE；新任务使用新 key |
| Loop iteration limit reached | 核对停止条件与 Graph 执行次数；不要直接无限提高预算 |
| 输出回执不是 accepted | 处理拒绝/未知状态，核对是否真正写入文件或外部系统 |

关闭顺序为：等待执行完成 → `runtime.close()` → 关闭应用数据库和 Redis 客户端。Runtime 不拥有外部 SDK 的全部生命周期。

## 14. 包功能验收

仓库提供以下命令，均不执行 npm 发布：

```sh
npm run check                         # 类型检查、构建和单元/回归测试
npm run check:package:basics           # 仓库外安装 tarball，分别验证主包和可选包
npm run check:package:basics:live       # 再验证真实模型、Redis、SQLite、跨进程与产物
npm run check:examples:control-flow:types
npm run check:examples:capabilities:types
```

基础包验收首先只安装主包，确认所有公开入口可导入、Context/工具可运行、可选检索包不存在；然后安装检索包，验证搜索和 TypeScript 契约扩展。真实任务验收使用三个进程完成两轮会话和重放，令 Redis 缓存过期后检查数据库恢复，并直接复核 SQLite 记录与答案文件。

已发布版本还可使用 `node --env-file=.env scripts/check-package-basics.ts --registry --live` 重新安装验证。报告写入 Git 忽略的 `.examples-package-basics-*-live-results.json`；本地 tarball 放在 `.release/`，不会作为包源码或测试产物提交。
