# 示例说明

[English](README.md) · **简体中文** · [Worker API](../docs/worker-api/README.zh-CN.md)

本目录放可以直接运行的完整流程示例。建议先看 `graph-loop-worker.ts` 理解 Graph、Loop、Worker 的分工，再看 `interaction-tools.ts` 接入真实命令及组合工具。

## 示例一览

| 示例代码 | 做什么 | 运行命令 | 前置条件 |
| --- | --- | --- | --- |
| [graph-loop-worker.ts](graph-loop-worker.ts) | 用 Graph 编排读取、观察、输出；用 Loop 处理两个文件；在 Worker 内定义文件统计工具 | `npm run example:agent` | Node 24+、npm 11+；无需模型、数据库或 MCP |
| [interaction-tools.ts](interaction-tools.ts) | 将 Linux/macOS 命令作为单个 tool，与 SHA-256 工具组合，并循环执行两组命令 | `npm run example:tools` | 同上；Linux 或 macOS，系统提供 uname / printf |

所有命令都在**项目根目录**运行。首次使用先安装依赖：

```bash
npm ci
```

两个 npm 示例命令都会先构建包，再执行对应 TypeScript 文件。两个示例均通过代码显式配置 Worker 和 Sandbox，不读取 `.env` 或 `ditto.yaml`，不需要在线模型密钥。

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

**学习内容：**操作系统交互只需要一个 `linux` tool，具体执行器可插拔，其他工具通过同一个 Worker 和 Graph 组合。

```text
linux tool → OBSERVE → sha256 tool → OBSERVE → OUTPUT
```

| 导出 | 做什么 |
| --- | --- |
| `commandExecutor` | 使用 Node execFile 执行命令，分开传递 command/args；设置工作目录、超时和输出上限 |
| `linuxTool` | 校验命令参数，通过 SandboxExecutor 执行；返回 stdout、stderr、exitCode，非零退出码转为 failed |
| `sha256Tool` | 对前一个工具输出的文本计算 SHA-256 |
| `CommandInput` | 定义 Graph 输入：id、command、args |
| `commandGraph` | 只包含命令及其 OBSERVE，供其他流程继续追加节点 |
| `toolGraph` | 在 commandGraph 后追加哈希工具、观察和输出 |

```bash
npm run example:tools
```

Loop 实际执行两组输入：

1. `uname -s`：macOS 返回 `Darwin`，Linux 返回 `Linux`，并计算包含结尾换行的原始 stdout 的摘要。
2. `printf`：原样输出 `Ditto: spaces; $(uname) stay literal` 并计算摘要。没有启动 shell，`$(uname)` 不会变成嵌套命令。

控制台输出两行 JSON，交付 ID 分别为 `os:delivery` 和 `literal:delivery`，每条消息包含命令结果及 SHA-256。命令失败时，Graph 不继续调用哈希工具。

本例执行器只允许 `uname`、`printf`、`pwd`、`false`；后两项用于集成测试。限制为 5 秒和 64 KiB 输出缓冲。它是显式的本机进程执行示例，不是操作系统隔离；部署时可以注入容器或 SSH 执行器，继续复用相同 Tool 契约。不会创建 `linux-commands/` 目录。

此文件仅在直接运行时启动示例。导入其导出对象不会执行命令，可复用 `commandExecutor`、工具与 Graph。

## 其他 API 示例与真实联调

| 入口 | 内容 | 使用方式 |
| --- | --- | --- |
| [API 示例说明](../docs/worker-api/examples/README.md) | MEMORY、INFER、INTERACTION、可选 RETRIEVAL；逐个函数说明用途 | 注入应用资源后调用需要的函数；不是自动执行的完整应用 |
| [MCP 实测脚本](../scripts/check-interaction-mcp-live.mjs) | 真实命令 → MCP 文件读取 → SHA-256 → OUTPUT | 按下方 [MCP](#mcp) 说明安装可选 SDK，并运行 `npm run check:interaction:mcp:live -- <依赖目录>` |
| [INFER 实测脚本](../scripts/check-infer-live.ts) | 对配置的真实模型验证采样和推理策略 | 按下方 [INFER](#infer) 说明配置 `.env`，再运行 `npm run check:infer:live -- --provider <名称>` |

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

参照根目录 [`.env.example`](../.env.example) 创建 `.env` 并填写供应商配置；在 [`ditto.yaml`](../ditto.yaml) 设置推理参数。配置字段见[统一配置 API](../docs/worker-api/configuration.zh-CN.md)。供应商名称应与配置一致：

```bash
npm run check:infer:live -- --provider deepseek
```

使用 `--strategies cot,tot,got` 筛选策略，`--cases sample,tot` 筛选用例，`--max-tokens 4096` 调整本次调用预算。`--report path` 指定结果文件；默认写入被 Git 忽略的 `.infer-live-results.json`。
