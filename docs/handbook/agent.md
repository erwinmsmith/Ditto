# 项目结构与完整 Agent

这一章将“导入一个模型”推进到“运行一个有状态的应用”。最终入口接收 `session`、`turn`、`prompt`，从 Memory 读取历史，使用 Redis 管理工作上下文，生成答案，保存会话，再写出答案文件。

## 1. 创建 npm 应用

使用 Node.js 24+、npm 11+。创建目录后执行：

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto redis@6.2.1
npm install --save-dev typescript @types/node
```

可选检索 Worker 不参与本章；无需安装检索包。`.env` 由应用加载，模型密钥不写进 Graph 或请求对象。

## 2. 推荐目录

```text
my-agent/
  package.json
  tsconfig.json
  .env                    # 本机配置，不提交
  src/
    main.ts               # 进程入口与请求校验
    runtime.ts            # 创建连接、注册 Worker、关闭资源
    contracts.ts          # 应用请求、计划、结果、检查点
    graphs/
      history.ts          # MEMORY.GET
      answer.ts           # LOAD → SELECT → SAMPLE → UPDATE
      persist.ts          # MEMORY.WRITE / UPDATE
      deliver.ts          # INTERACTION.OUTPUT
    plans/
      conversation.ts     # 单次 runtime.loop 的生成器计划
    tools/                # 业务 API、文件、浏览器、MCP 适配器
    storage/              # Redis、SQL、向量库连接和接口实现
    skills/               # 可信指令与附属资料
  data/                   # 数据库与任务产物；部署时挂持久卷
```

小项目可以将 Graph 和计划放在一个文件中；当一个阶段被多个任务复用时再拆分。目录名不是 Ditto 的自动发现约定，所有资源显式导入和注册。

## 3. 直接运行完整样例

从[示例下载说明](examples.md)获取示例包，在解压后的根目录执行：

```sh
npm install
cp examples/package-basics/.env.example .env
# 编辑 .env，配置真实供应商、模型和 Redis 地址。
redis-server --bind 127.0.0.1 --port 6379
```

Redis 在一个终端中运行；另开终端提交请求：

```sh
node --env-file=.env examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt '记住我的项目代号是 orchid-42。'
node --env-file=.env examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt '我的项目代号是什么？'
```

每个命令都是新进程。第二轮必须从 SQLite 恢复历史，而不是依赖前一进程的内存变量。默认目录 `.examples-package-basics-tasks/alice` 保存 `memory.sqlite` 与 `answers/turn-2.md`。CLI 返回答案、文件路径和 `replayed`。

若已克隆源码仓库，先 `npm ci`，再 `npm ci --prefix examples/_shared/tools/storage/dependencies`，随后运行同样的 CLI。源码仓库的 prepare 会构建包；下载的消费者示例不编译框架源码。

## 4. 一次请求内部发生什么

```text
可信应用控制器验证 session / turn / prompt
                  ↓
        runtime.loop(conversationPlan)
                  ↓
            History Graph
              MEMORY.GET
                  ↓
  ┌─ 最近一轮已完成且输入一致 ───────────────┐
  │                                       │
  └─ 新请求 → Answer Graph                │
            CONTEXT.LOAD(scope,sources)   │
               → CONTEXT.SELECT           │
               → INFER.REASONING.SAMPLE    │
               → CONTEXT.UPDATE           │
                  ↓                        │
            Persist Graph                 │
           MEMORY.WRITE / UPDATE          │
                  ↓                        ↓
                  Deliver Graph → INTERACTION.OUTPUT
```

同一阶段的节点依赖在 Graph 中声明，不同阶段通过 Loop 的 `yield* graphStep(...)` 调度。没有在应用计划中绕过 Runtime 直接运行 Worker executor。

## 5. 入口的关键代码

完整文件：[agent.ts](../../examples/package-basics/agent.ts)。它已经包含输入校验、节点结果检查、资源关闭、历史限长和最近一轮重放。

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { runAgent } from "./examples/package-basics/agent.ts";

const config = loadRuntimeConfig(process.env, {
  runtime: { timeoutMs: 60_000 },
  workers: { context: { cache: { ttlMs: 300_000 } } },
});
const result = await runAgent(
  { session: "alice", turn: "turn-3", prompt: "根据历史说明这个项目。" },
  "./data",
  config,
);
console.log(result.answer, result.file);
```

`runAgent` 是可复制的应用函数，不是主包导出。上线服务应在可信身份验证后选择 session/目录，不让模型或任意 HTTP 参数决定数据库文件路径。

## 6. 如何修改成自己的 Agent

| 要修改的行为 | 修改位置 | 保持的约束 |
| --- | --- | --- |
| 输出风格或角色 | Answer Graph 的 system 指令 | 用户/网页内容不升级为 system |
| 增加历史检索 | History Graph 增加 MEMORY.SEARCH | 检查 NodeResult，显式映射 ContextItem |
| 增加工具 | 注册 Interaction 工具，在 Graph 加 ACT.TOOL/OBSERVE | 权限、参数校验、幂等和超时由工具落实 |
| 多轮自主执行 | 替换 conversationPlan | 只有 Loop 调度 Graph，共享预算 |
| 改数据库 | 替换 storage 适配器 | 保持 MemoryStore 契约和错误语义 |
| 发布到业务系统 | 替换 OutputSink 或添加发布工具 | 校验回执，并核对实际外部状态 |

## 7. 恢复能力的范围

这个入门实现只保存最近一次 turn 的重放状态，并为下一轮保留最多五轮历史。相同 turn 使用不同 prompt 会被拒绝；同一会话需要串行执行。它没有多租户鉴权、任意历史重放、跨业务事务的自动回滚。

需要长任务检查点、已执行副作用核对和跨进程阶段恢复时，使用 [4.16 长任务示例](../../examples/patterns/long-running/README.zh-CN.md)。完整生产入口应分别记录任务状态、长期 Memory 和业务操作账本。

下一步：[Graph 与 Loop](graph-loop.md) → [连接模型](models.md) → [Tool](tools.md)。
