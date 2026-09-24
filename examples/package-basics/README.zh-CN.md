# npm 基础使用示例

[English](README.md) · [完整使用教程](../../docs/package-guide.zh-CN.md) · [示例索引](../README.zh-CN.md)

这里的四个入口可以从仓库运行，也可以复制到独立 npm 消费者项目。所有框架调用来自 `@codesoul-co/ditto` 和可选的 `@codesoul-co/ditto-retrieval` 公开入口，导入模块本身不运行任务。

| 入口 | 展示内容 | 依赖与验收终点 |
| --- | --- | --- |
| [context.ts](context.ts) | Context LOAD → SELECT，Graph 输入依赖 | 只需主包；返回包含输入文本的 ContextSelection |
| [tools.ts](tools.ts) | 工具注册、参数验证、Sandbox 允许列表、结果观察 | 只需主包；正确统计 Unicode code point 数量 |
| [retrieval.ts](retrieval.ts) | 可选检索包、target registry、Provider、来源引用 | 额外安装检索包；返回命中文档或空候选 |
| [agent.ts](agent.ts) | 一次 Loop 调度多张 Graph，多轮对话、恢复和输出 | 真实模型 + Redis Context + SQLite Memory；写出答案文件并保存会话 |

前三项是聚焦的 API/适配器演示。`agent.ts` 才是包含模型、持久化和可核对业务产物的完整任务。

## 从仓库运行

```sh
npm ci
node examples/package-basics/context.ts 'Hello Ditto'
node examples/package-basics/tools.ts 'A😀'
node examples/package-basics/retrieval.ts Redis
```

Context 输出包含 `Hello Ditto`；工具的 `counted.structuredContent.characters` 为 `2`；检索命中 ID 为 `context`、来源为 `guide.md#context`。检索演示仅对两条应用文档做关键词过滤，不生成向量或启动搜索数据库。

## 真实 Agent

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env.local
# 编辑 .env.local，设置真实 Provider、模型和网络 origin。
# 在另一终端启动 Redis，或使用现有 Redis 服务。
redis-server --bind 127.0.0.1 --port 6379
```

```sh
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt '记住项目代号 orchid-42。'
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt '我的项目代号是什么？'
```

输出形如 `{ "answer": "orchid-42", "file": "…/alice/answers/turn-2.md", "replayed": false }`。模型措辞可变化，验收关注语义和实际存储。默认目录 `.examples-package-basics-tasks` 可用 `--directory` 替换。

同一个最近 turn 的相同 prompt 可重放；改动 prompt 会被拒绝。每个新请求使用新的 turn ID，同一 session 串行执行。本例保留最近五轮历史用于后续上下文，并保存最近一轮重放结果。它不支持并发写同一会话、认证、多租户授权或任意旧任务重放；这些由宿主控制器和对应完整模式接入。

Memory 保存发生在答案输出之前，输出失败后可以重放最近一轮。模型失败不写入已完成记录。Redis 不可用时失败；缓存过期后，下一轮从 SQLite Memory 重新加载历史。

## 程序调用

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { runAgent } from "./examples/package-basics/agent.ts";

const result = await runAgent(
  { session: "alice", turn: "turn-1", prompt: "帮我总结这个需求。" },
  "./.examples-package-basics-tasks",
  loadRuntimeConfig(process.env, { runtime: { timeoutMs: 60_000 } }),
);
console.log(result.answer, result.file);
```

`runAgent` 是示例应用函数，不是 npm 包的导出。它创建并关闭本次 Runtime、Redis 与 SQLite 资源。会话身份和目录由可信应用提供；接入服务时在认证和会话串行化之后调用。

## 复制到自己的项目

消费者安装主包和 `redis@6.2.1`，复制本目录、`../_shared/tools/package-basics.ts` 和 storage 下的 `workers.ts`、`redis-context.ts`、`sqlite-memory.ts`、`sql-memory.ts`、`dependencies/package.json`，保持目录关系。运行检索示例时再安装检索包。具体复制命令、TypeScript 配置及环境变量解释见[完整教程](../../docs/package-guide.zh-CN.md#10-在自己的-npm-项目中复用这些文件)。

## 验收

```sh
npm run check:package:basics
# .env 中配置真实模型和 Redis 后：
npm run check:package:basics:live
```

检查会在仓库外创建消费者，先仅安装主包，再安装可选检索包，验证所有公开导出、严格 TypeScript、模块静默导入和任务输出。真实 Agent 验收通过不同进程运行两轮及重放，主动令 Redis 缓存过期，直接读取 SQLite 与答案文件验证结果。测试不使用模型替身，不把其他数据库的适配器能力视为已完成的外部服务验收。
