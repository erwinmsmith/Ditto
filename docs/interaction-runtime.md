# Agent、Provider 与运行环境

交互循环、工具、MCP 和 Skill 在 `src/worker/interaction/`，模型生成与适配器在 `src/worker/reasoning/`。没有独立 agent 子系统；Runtime 提供基础服务，应用负责建立外部连接和选择部署策略。

## 配置顺序与环境文件

1. 应用通过 Node 的 `--env-file=.env`（可选文件用 `--env-file-if-exists`）加载环境。
2. `loadRuntimeConfig()` 显式解析并校验环境变量，传给 `createDitto({ config })`。
3. Worker 的 `createInteractionNodes({ model })` 可覆盖 Runtime 默认模型；未指定则使用 `config.model`。
4. `createDitto({ sandbox })` 若提供完整策略，会替代配置中的 sandbox 策略；未列出的权限仍拒绝。

导入库、调用不带 config 的 createDitto 都不会读取 `.env` 或环境变量中的凭证。配置中包含环境标识、工作区、默认 Provider/模型、Provider 配置、请求超时、Agent 轮次和权限。`environment` 是运行环境标签，不会自动启动容器或切换安全等级。

所有变量见 [.env.example](../.env.example)。`.env` / `.env.*` 已忽略，仅 example 可提交。Key 保存在执行端配置/适配器闭包中，不进入 Graph 或通信 Envelope 的配置字段；应用不要记录完整 config。

一个真实模型配置例子（模型名替换为账户可用 ID）：

```dotenv
DITTO_PROVIDERS=primary,claude
DITTO_MODEL_PROVIDER=primary
DITTO_MODEL=your-model-id
DITTO_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_PROVIDER_PRIMARY_BASE_URL=https://api.openai.com/v1
DITTO_PROVIDER_PRIMARY_API_KEY=replace-locally
DITTO_PROVIDER_CLAUDE_KIND=anthropic
DITTO_PROVIDER_CLAUDE_BASE_URL=https://api.anthropic.com/v1
DITTO_PROVIDER_CLAUDE_API_KEY=replace-locally
DITTO_ALLOW_NETWORK=https://api.openai.com,https://api.anthropic.com
DITTO_ALLOW_TOOLS=echo
DITTO_ALLOW_SKILLS=concise
```

上面的 echo/concise 仅表示白名单配置格式，应用需要自行注册对应工具与 Skill；环境变量不会自动创建能力。`examples/worker-graph.ts` 是无需网络的结构示例，不使用这些配置。

## 多 Provider

`ModelProvider.generate(ModelRequest)` 返回规范化文本和 toolCalls。`ProviderRegistry` 通过名称注册实现；默认根据 config 自动装配 HTTP Provider。显式注入 `providers` 注册表时，应用负责完整注册，不自动追加配置中的 Provider。

内置支持 OpenAI 兼容 Chat Completions 和 Anthropic Messages 的文本、函数工具请求/结果。OpenAI 的 tool_calls/tool_call_id 与 Anthropic 的 tool_use/tool_result 在适配器内转换。模型名由配置提供；不固定易过时的模型目录，不自动切换 Provider、重试或调用计费 API 探测能力。

```ts
const worker = defineWorker({
  type: "reviewer", expose: ["INTERACTION.RUN"],
  nodes: createInteractionNodes({ model: { provider: "claude", model: "your-model-id" } }),
});
```

自定义 SDK、第三种厂商、流式或多模态模型可实现 `ModelProvider` 并注册。当前内置适配器不提供流式、图像、厂商推理 block 或完整厂商参数透传；不支持的响应块会失败，避免静默丢失信息。自定义 Provider 必须自行遵守网络权限和传入的 AbortSignal；Core 无法截获适配器内任意直接 I/O。

协议参考：[OpenAI Chat API](https://developers.openai.com/api/reference/cli/resources/chat)、[Anthropic 工具调用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

## Agent Node 与工具循环

| Node | 输入/行为 |
| --- | --- |
| `INTERACTION.RUN` | 接收规范化 messages 和可选 Skill 名称；有界模型/工具循环 |
| `REASONING.GENERATE` | 调用所选 Provider，并仅提供当前权限允许的工具 schema |
| `INTERACTION.TOOL` | 检查权限、校验 arguments，然后执行本地或 MCP 工具 |
| `INTERACTION.SKILL` | 按名称获取已注册且被允许的 Skill 指令 |

这些契约独立扩展自 NodeContractMap，没有修改 v1.0 Message 或 REASONING.INFER。`ModelMessage` 单独表示工具调用 ID 与结果关联，避免把 Provider 协议字段塞进原 Message。

`createInteractionNodes({ tools, skills, model, maxTurns })` 返回可直接 spread 到 Worker.nodes 的四个 handler。推荐 expose 仅包含 INTERACTION.RUN。模型和工具任务通过 `ctx.run` 在同一副本上执行；可替换其中一个 handler来定制行为。若 Worker 另有资源/config 类型，使用 `createInteractionNodes<Resource, Config>(...)`。

工具请求必须属于本轮可用集合，调用 ID 不可重复。工具按顺序执行，arguments 由必需的 validate 回调校验后才产生副作用。工具异常会使 Agent 失败；MCP 返回的 isError 则保留为工具结果。最后一轮仍要求工具时直接触发上限，不执行无法再交给模型处理的副作用。

此循环不保证事务、长期记忆、上下文裁剪或无限自主运行。maxTurns 限制模型轮数，timeoutMs 限制内置 Provider 单次请求；并非整个 Agent/工具/MCP 会话的硬截止时间。工具作者需为自身 I/O 设置截止时间。

## 工具与 MCP

本地工具使用 ToolRegistry.register，包含 name、description、inputSchema、validate 和 execute。Schema 描述给模型看的参数，validate 是实际执行前的检查；Core 没有引入 JSON Schema 引擎。需要完整 JSON Schema 校验的应用可在 validate 中接入自己的验证器。

```ts
const tools = new ToolRegistry();
tools.register({
  name: "read_text", description: "Read a workspace file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate: (args) => { if (typeof args.path !== "string") throw new Error("path must be string"); },
  execute: async (args, ctx) => ctx.services.sandbox.readText(args.path as string),
});
```

MCP 由应用使用官方 SDK 连接 stdio 或 Streamable HTTP 服务，再将连接适配成 McpClient。Core 不自行启动任意 MCP 进程或实现另一套 JSON-RPC 协议。

```ts
// client 是应用已连接、配置认证及超时的 MCP SDK 客户端。
const remove = await registerMcpTools(tools, "files", client, runtime.services.sandbox);
// tools/list 分页结果注册为 files__<tool-name>；tools/call 返回值保留。
// 停止使用后：remove(); await client.close();（连接归应用所有）
```

注册前与调用时均检查 MCP server 白名单，调用还要求完整工具名在 tools 白名单中。MCP 工具参数 schema 由服务端校验；本地只校验对象形状与权限。分页重复/注册冲突时回滚本次注册；返回 remove 可以卸载本次工具。工具名需满足通用 Provider 的 `[a-zA-Z0-9_-]`、最多 64 字符，非法名称明确报错；工具列表变化后由应用刷新注册。

MCP 的网络和进程权限由建立连接的 SDK/部署沙箱约束；允许 server 名称不等于允许远端服务访问客户端文件系统。协议参考：[MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。

## Skill 管理

SkillRegistry 支持 register/list/get，以及 `load(name, path, sandbox)` 读取工作区内 SKILL.md。名称由调用方显式给定，文件完整内容作为指令保存；不隐式解析 YAML、扫描全盘、执行脚本或下载依赖。

加载需要 read 与对应 skills 权限；每次读取注册内容再次检查 skills 权限。register 返回卸载函数。`INTERACTION.RUN` 仅加载输入中明确指定的 Skill，将其指令加入模型上下文。Skill 文本无法扩大工具/网络/执行权限，也不会自动运行引用的文件。

## Sandbox 边界

默认拒绝文件读写、外部命令以及 tools/mcp/skills/network。白名单使用精确名称，network 使用 URL origin；`*` 是明确允许全部。内置 Provider 在网络请求前检查 origin，且拒绝 HTTP 重定向；Worker transport 是应用部署控制面，使用单独配置的地址与凭证。

Sandbox.readText/writeText 将路径限制在工作区，解析已有 symlink，并拒绝指向外部或悬空目标的写入。不递归创建目录。`run` 只有 execute=true 且应用提供 SandboxExecutor 时才执行，不会回退到宿主机 shell。

这是合作式权限服务，无法隔离同进程 Node/Tool 的任意 JavaScript、阻止绕过服务的 fs/fetch 或解决攻击者并发替换路径的全部竞态。对不可信插件/命令，部署到受 OS/容器控制的独立进程，约束挂载、网络、环境变量、资源和超时；SandboxExecutor 实现承担这些隔离保证。默认不透传宿主环境或模型 Key 给命令。
