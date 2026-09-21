# INTERACTION 真实执行验证

验证日期：2026-09-21。使用真实操作系统进程、官方 MCP SDK 与 filesystem server；工具执行结果未使用 mock。

## 结果

| 项目 | macOS / Node 24.11.1 | Linux 容器 / Node 24.21.0 |
| --- | --- | --- |
| `linux` tool 执行 `uname -s` | `Darwin\n`，退出码 0 | `Linux\n`，退出码 0 |
| `printf` 传递空格、中文、分号、管道符及命令替换字样 | 原样输出，不经过 shell 展开 | 原样输出，不经过 shell 展开 |
| `pwd` 与 Runtime workspace | 一致 | 一致 |
| 命令 → OBSERVE → SHA-256 工具 → OBSERVE → OUTPUT | 通过，Loop 可重复执行 | 通过，Loop 可重复执行 |
| `false` 返回非零退出码 | 保留退出码 1，返回 failed，后续 hash 不执行 | 同左 |
| 未开放 tools/execute 权限或参数非法 | 执行器调用次数为 0 | 同左 |
| MCP stdio 连接与工具发现 | 发现 14 个工具，含 `read_text_file` | 同左 |
| 命令 → MCP 文件读取 → SHA-256 → OUTPUT | accepted，内容和关联 ID 校验通过 | 同左 |
| MCP 读取不存在的文件 | failed / MCP_TOOL_ERROR | 同左 |

MCP 使用 `@modelcontextprotocol/sdk@1.30.0` 与 `@modelcontextprotocol/server-filesystem@2026.8.31`，在独立子进程中读取临时文件，文件名包含空格和中文。两种平台得到相同摘要：

```text
afab2655c1316d159f4f19acf2ef69969b78236792411e71b05137e15b53d044
```

macOS 完整检查：108 项测试通过，类型检查与构建通过。Linux 运行 3 项命令集成测试、命令示例和 MCP 实测脚本，全部通过。Linux 镜像为 `node:24-bookworm-slim`，digest 为 `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`；验证容器禁用网络，仓库和 SDK 以只读目录挂载，临时文件写入 `/tmp`。

## 直接运行命令工具

在项目根目录使用 Node 24+：

```bash
npm run example:tools
```

[示例源码](../../examples/interaction-tools.ts)把 Linux/macOS 操作作为单个 `linux` tool，并与普通 `sha256` tool 注册到同一个 `createInteractionWorker()`。Graph 只定义数据传递，Loop 定义迭代；操作系统执行使用应用注入的 `SandboxExecutor`。

示例执行器使用 Node `execFile`，分开传递 command/args，并固定 `shell: false`。本例只启用 `uname`、`printf`、`pwd`、`false`，单次执行超时为 5 秒，输出缓冲上限为 64 KiB。非零退出码作为工具结果保留；启动失败、超时等基础设施错误仍抛出异常。

这是一份显式授权的本地执行示例，不是默认启用的 Core 命令实现，也不是操作系统隔离。部署时可替换成容器或 SSH 执行器；工作目录本身不限制命令的文件访问。无需恢复 `linux-commands/` 目录。

## 真实 MCP 与其他工具组合

可选依赖安装到独立临时目录，不修改 Ditto 的 package.json 或锁文件：

```bash
mcp_deps="$(mktemp -d)"
npm install --prefix "$mcp_deps" --no-audit --no-fund --ignore-scripts \
  @modelcontextprotocol/sdk@1.30.0 \
  @modelcontextprotocol/server-filesystem@2026.8.31
npm run check:interaction:mcp:live -- "$mcp_deps"
```

[实测脚本](../../scripts/check-interaction-mcp-live.mjs)展示完整接入过程：应用创建并连接 MCP Client，将 `listTools` / `callTool` 包装为 Ditto 的中立接口，注入 Worker 的 `mcp: { files: adapter }`。Graph 将命令生成的文件路径交给 MCP，再将文件内容交给普通工具计算摘要，最后由 OUTPUT 返回接收回执。

脚本结束时关闭 Runtime、MCP Client 和 transport，并删除本次创建的临时文件。SDK 连接生命周期由应用持有；Core 不安装 SDK、不自动建立外部连接。这里验证的是本地 stdio filesystem server，不代表所有第三方 MCP 服务均已测试；OUTPUT 的 accepted 仅表示示例接收端接受了结果。

在 Linux 容器中复验同一套代码（先完成上面的依赖安装）：

```bash
npm run check
docker run --rm --network none --read-only \
  --mount "type=bind,src=$PWD,dst=/app,readonly" \
  --mount "type=bind,src=$mcp_deps,dst=/opt/mcp,readonly" \
  --tmpfs /tmp -w /app node:24-bookworm-slim \
  sh -c 'node --test .test-dist/test/interaction-commands.test.js && node examples/interaction-tools.ts && node scripts/check-interaction-mcp-live.mjs /opt/mcp'
```

## 接入你自己的工具

| 内容 | 接入位置 |
| --- | --- |
| Linux/macOS、容器、SSH 执行 | `RegisteredTool.execute()` 调用应用执行器；本例经 `context.services.sandbox.run()` |
| 普通计算、HTTP 或 SDK 工具 | `createInteractionWorker({ tools: [...] })`，实现 validate / execute |
| MCP 服务 | `createInteractionWorker({ mcp: { 服务名: clientAdapter } })` |
| 数据库 | `createMemoryWorker({ store, search? })`，Graph 调用 MEMORY 节点 |
| 组合流程和循环 | `graph()` / `loop()`，不放进工具实现内部 |

本次实测覆盖命令、普通计算与 MCP 的组合；数据库能力继续使用已有 MEMORY 适配接口，本次未新增数据库联调。
