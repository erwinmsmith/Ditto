# 示例说明

[English](guide.md) · **简体中文** · [Worker API](../README.zh-CN.md)

本目录放可以直接运行的完整流程示例。建议先看 `graph-loop-worker.ts` 理解 Graph、Loop、Worker 的分工，再看 `interaction-tools.ts` 接入真实命令及组合工具。

## 示例一览

| 示例代码 | 做什么 | 运行命令 | 前置条件 |
| --- | --- | --- | --- |
| [graph-loop-worker.ts](graph-loop-worker.ts) | 用 Graph 编排读取、观察、输出；用 Loop 处理两个文件；在 Worker 内定义文件统计工具 | `npm run example:agent` | Node 24+、npm 11+；无需模型、数据库或 MCP |
| [interaction-tools.ts](interaction-tools.ts) | 注册可选只读命令和一个底层命令示例，再把命令输出与 SHA-256 工具组合 | `npm run example:tools` | 同上；Linux 或 macOS，系统提供 grep / uname / printf |
| [runtime/quickstart.ts](../../../examples/quickstart.ts)、[api.ts](runtime/api.ts)、[flows.ts](runtime/flows.ts) | 入门与公共 API：自定义节点、生命周期、事件/Artifact、预定义流程 | `npm run example:runtime:quickstart` / `example:runtime:api` / `example:runtime:flows` | 本地入口无需外部服务；MCP/ReAct 函数需注入服务 |
| [runtime/](runtime/README.zh-CN.md) | 多 Graph Loop、独立 Worker Sandbox、同机 IPC 与跨机 HTTP | `npm run example:runtime` / `npm run example:runtime:placement` | 无额外 SDK 或服务 |
| [worker/](integrations/README.zh-CN.md) | CONTEXT 接 Redis；MEMORY 接 SQLite/PostgreSQL/MySQL/Milvus | 见子目录运行命令 | 按需安装 SDK、配置数据库 |

所有命令都在**项目根目录**运行。首次使用先安装依赖：

```bash
npm ci
```

前两个 npm 示例命令都会先构建包，再执行对应 TypeScript 文件。两个示例均通过代码显式配置 Worker 和 Sandbox，不读取 `.env` 或 `ditto.yaml`，不需要在线模型密钥。

## graph-loop-worker.ts：最小 Agent 执行流程

**学习内容：**只定义 Graph、Loop 和 Worker 内的能力，就可以执行一段完整流程。

| 部分 | 文件中的作用 |
| --- | --- |
| Graph `inspect` | 定义 `ACT.TOOL → OBSERVE → OUTPUT`，传递文件路径、调用 ID 和观察结果 |
| Loop `inspectFiles` | 维护 paths/index 状态；依次处理两份文件，完成后停止 |
| Tool `inspect_text` | 通过 Sandbox 真实读取文件，统计字符数和按换行分割的行数 |
| Interaction Worker | 注册 inspect_text 和控制台 OutputSink |
| Runtime | 开放该工具及读取权限，执行 Loop，并在结束时关闭 |

```bash
npm run example:agent
```

实际读取 `README.md` 和 `package.json`，控制台输出两行 JSON。每行包含 `deliveryId` 和 assistant 消息，消息数据中含 `path`、`characters`、`lines`；统计值会随文件内容变化。示例不修改这两个文件。

可以修改 `paths` 换成其他工作区文件，并同步调整 `maxIterations`；也可以替换 Tool 的 execute 实现，再由 Graph 定义后续处理。此文件在顶层运行流程，**导入它也会执行示例**，适合直接运行或作为应用入口参考。

## interaction-tools.ts：真实系统命令与普通工具组合

**学习内容：**显式注册 14 个可复用只读命令，并让它们与底层 `linux` tool 共用可插拔执行器；其他工具继续通过同一个 Worker 和 Graph 组合。

```text
linux tool → OBSERVE → sha256 tool → OBSERVE → OUTPUT
```

| 导出 | 做什么 |
| --- | --- |
| `commandExecutor` | 使用 createLocalSandboxExecutor 执行命令，分开传递 command/args；设置工作目录、超时和输出上限 |
| `readOnlyCommandTools` | Core 提供的 14 个可选、有界只读命令注册项 |
| `linuxTool` | 校验命令参数，通过 SandboxExecutor 执行；返回 stdout、stderr、exitCode，非零退出码转为 failed |
| `sha256Tool` | 对前一个工具输出的文本计算 SHA-256 |
| `CommandInput` | 定义 Graph 输入：id、command、args |
| `commandGraph` | 只包含命令及其 OBSERVE，供其他流程继续追加节点 |
| `toolGraph` | 在 commandGraph 后追加哈希工具、观察和输出 |

```bash
npm run example:tools
```

进入 Loop 前，`grep` 先通过 ACT.TOOL 和 OBSERVE 搜索 README。随后 Loop 执行两组输入：

1. `uname -s`：macOS 返回 `Darwin`，Linux 返回 `Linux`，并计算包含结尾换行的原始 stdout 的摘要。
2. `printf`：原样输出 `Ditto: spaces; $(uname) stay literal` 并计算摘要。没有启动 shell，`$(uname)` 不会变成嵌套命令。

控制台第一行 JSON 是 grep Observation；后两行交付 ID 分别为 `os:delivery` 和 `literal:delivery`，每条消息包含命令结果及 SHA-256。命令失败时，Graph 不继续调用哈希工具。

本例执行器允许 14 个只读命令，以及底层示例和集成测试使用的 `uname`、`printf`、`false`。执行限制为 5 秒和 64 KiB 输出缓冲。它是显式的本机进程执行示例，不是操作系统隔离；部署时可以注入容器或 SSH 执行器，继续复用相同 Tool 契约。

此文件仅在直接运行时启动示例。导入其导出对象不会执行命令，可复用 `commandExecutor`、工具与 Graph。

## 其他 API 示例与真实联调

| 入口 | 内容 | 使用方式 |
| --- | --- | --- |
| [API 示例说明](README.md) | MEMORY、INFER、INTERACTION、可选 RETRIEVAL；逐个函数说明用途 | 注入应用资源后调用需要的函数；不是自动执行的完整应用 |
| [MCP 实测脚本](../../../scripts/check-interaction-mcp-live.mjs) | 真实命令 → MCP 文件读取 → SHA-256 → OUTPUT | 按下方 [MCP](#mcp) 说明安装可选 SDK，并运行 `npm run check:interaction:mcp:live -- <依赖目录>` |
| [INFER 实测脚本](../../../scripts/check-infer-live.ts) | 对配置的真实模型验证采样和推理策略 | 按下方 [INFER](#infer) 说明配置 `.env`，再运行 `npm run check:infer:live -- --provider <名称>` |
| [Web search 实测脚本](../../../scripts/check-interaction-web-search-live.mjs) | Brave Search → ACT.TOOL → OBSERVE → CONTEXT.UPDATE | 设置 `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`，再运行 `npm run check:interaction:web-search:live -- "查询"` |

### Web search

实测脚本显式创建 Brave 适配器和 `web_search` Tool，开放该 Tool 与 Brave 精确 origin，并检查真实结果已生成 Observation 和一条 Context item。脚本只打印规范化结果，不打印 API key。Core 本身不会读取这个环境变量；脚本作为应用层负责注入。

```bash
DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY="..." npm run check:interaction:web-search:live -- "Ditto agent runtime"
```

### MCP

安装脚本使用的可选 MCP SDK 和 filesystem server，再执行命令、文件读取和工具组合：

```bash
mcp_deps="$(mktemp -d)"
npm install --prefix "$mcp_deps" --no-audit --no-fund --ignore-scripts \
  @modelcontextprotocol/sdk@1.30.0 \
  @modelcontextprotocol/server-filesystem@2026.8.31
npm run check:interaction:mcp:live -- "$mcp_deps"
```

### INFER

参照根目录 [`.env.example`](../../../.env.example) 创建 `.env` 并填写供应商配置；在 [`ditto.yaml`](../../../ditto.yaml) 设置推理参数。配置字段见[统一配置 API](../configuration.zh-CN.md)。供应商名称应与配置一致：

```bash
npm run check:infer:live -- --provider deepseek
```

使用 `--strategies cot,tot,got` 筛选策略，`--cases sample,tot` 筛选用例，`--max-tokens 4096` 调整本次调用预算。`--report path` 指定结果文件；默认写入被 Git 忽略的 `.infer-live-results.json`。

## CONTEXT / Redis

`createContext()` 可直接执行无状态示例。缓存调用需要应用提供 Redis 服务及 SDK；从根目录运行：

```bash
redis_deps="$(mktemp -d)"
npm install --prefix "$redis_deps" --no-audit --no-fund --ignore-scripts redis@6.2.1
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379 npm run check:context:redis:live -- "$redis_deps"
```

应用项目中安装 `redis`，使用 `.env` 的地址创建连接，再注入 Worker。使用 Node `--env-file=.env` 或应用自己的环境加载器：

```ts
import { createClient } from "redis";
import { createContextWorker, createDitto, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const redis = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL });
redis.on("error", () => { /* Application logging/health reporting. */ });
await redis.connect();
const runtime = createDitto({ config, workers: [createContextWorker({
  ...(config.context.policy ? { policy: config.context.policy } : {}),
  redis: { client: redis, ...config.context.cache },
})] });
try {
  const scope = { sessionId: "tenant-a:session-1" };
  await runtime.invoke("CONTEXT.LOAD", { scope, sources: [{ role: "user", content: "hello" }] });
  const selected = await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer" });
  console.log(selected.context);
} finally {
  await runtime.close();
  await redis.quit();
}
```

[每个 CONTEXT 示例的说明](README.md#contextts) · [完整 API](../context.zh-CN.md)

## CONTEXT 与 RETRIEVAL 组合

[worker/context-retrieval.ts](integrations/context-retrieval.ts) 使用真实 SQLite FTS5，比较普通 CONTEXT 内联检索与可选 RETRIEVAL Worker，包含本地缓存、队列、引用解析及 LOAD → SELECT Graph。运行 `npm run example:worker:context-retrieval`；无外部凭据，详细说明见 [Worker 示例](integrations/README.zh-CN.md#context-缓存与可选检索)。

`interaction-tools.ts` 的 commandExecutor 复用 Core 的 `createLocalSandboxExecutor`，timeoutMs/maxOutputBytes 来自根 YAML 的 runtime.sandbox；示例不再维护另一套进程执行实现。运行 `npm run example:tools` 可验证命令 → OBSERVE → SHA-256 → OUTPUT 的 Graph/Loop。
