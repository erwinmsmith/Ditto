# INTERACTION Worker API

[English](interaction.md) · **简体中文** · [Worker API](README.zh-CN.md)

INTERACTION 执行外部动作、标准化观察并交付最终消息。Graph 定义调用顺序与数据依赖，Loop 管理迭代和停止条件，Worker 注入工具、MCP 客户端与输出接收端。没有独立 Agent 管理层、命令自动注册或插件扫描器。

## 1. 入口与 API 清单

```ts
import { createBraveWebSearchProvider, createInteractionWorker, createReadOnlyCommandTools, createWebSearchTool, ToolRegistry, McpRegistry } from "@codesoul-co/ditto/worker/interaction";
// Also exported by @codesoul-co/ditto.
```

| API | 返回 / 用途 |
| --- | --- |
| `createInteractionWorker(options?)` | WorkerDefinition；普通接入入口 |
| `createInteractionNodes(options?)` | WorkerNodes；供自定义 defineWorker 使用 |
| `ToolRegistry.register / list / call` | 注册/移除工具、列出可用工具、执行单次调用 |
| `createReadOnlyCommandTools(options?)` | 返回 14 个可选只读命令注册项，使用结构化输入和有界输出 |
| `createWebSearchTool({ provider })` | 返回可选、Provider 中立的 `web_search` 注册项，结果经过有界规范化 |
| `createBraveWebSearchProvider(options)` | 基于原生 fetch 的 Brave Web Search 适配器；凭证由应用提供 |
| `McpRegistry.register / execute` | 注册/移除客户端、发现或调用 MCP 工具 |
| `createToolHandler / createMcpHandler / createOutputHandler` | 构建各叶子 NodeHandler |
| `observeExternalResult(input)` | 同步返回 Observation；纯标准化函数 |
| `RegisteredTool.validate / execute` | 应用工具接口，execute 返回 ToolExecutionOutcome |
| `McpClient.listTools / callTool` | 应用拥有的 SDK 客户端适配接口 |
| `OutputSink.deliver` | Promise<OutputReceipt>；交付通道接口 |

| Node | Input | Output |
| --- | --- | --- |
| INTERACTION.ACT.TOOL | `{ call: ToolCall }` | `ExternalResult` |
| INTERACTION.ACT.MCP | discover / invoke union | discover / invoke union |
| INTERACTION.OBSERVE | `{ result: ExternalResult }` | `Observation` |
| INTERACTION.OUTPUT | `{ deliveryId, message, artifacts? }` | `OutputReceipt` |

这四个节点直接返回上表 Output，**不套 NodeResult**，没有统一的 executionId/output 字段。动作关联使用 callId，交付关联使用 deliveryId。注册和输入校验错误、权限拒绝、未分类 SDK 异常会拒绝 Promise；业务失败应通过结构化结果表达。

## 2. 完整示例与初始化

以下示例共享 [examples/interaction.ts](examples/interaction.ts) 的 imports；完整文件参与 `npm run typecheck`，导入不会执行示例。SDK 参数由应用先连接，再注入；函数不会替你创建凭据或数据库。

```ts
import { createDitto, defineWorker, graph, loop, type WorkerContext } from "@codesoul-co/ditto";
import {
  createInteractionWorker, createInteractionNodes, createToolHandler, createMcpHandler,
  createOutputHandler, observeExternalResult, ToolRegistry, McpRegistry,
  interactionObserveNode, type RegisteredTool, type McpClient, type OutputSink,
} from "@codesoul-co/ditto/worker/interaction";
```

### RegisteredTool.validate / execute

工具定义的字段如下。Schema 是能力描述，Core 不安装 JSON Schema validator；validate 必须校验实际业务参数。execute 只负责一次动作，不在内部构建 Agent 循环。

| 字段 | 要求与行为 |
| --- | --- |
| `name` | 必填，1–64 个字母、数字、下划线或连字符；同 Registry 内唯一 |
| `description?` | 能力描述 |
| `inputSchema` | 必填 JsonObject；提供给调用者/模型，不自动执行 Schema 校验 |
| `effects?` | read / write / execute / network 数组；描述副作用 |
| `requiresApproval?` | 描述性标记；Core 不自动弹出审批或改变 Sandbox 权限 |
| `validate(args)` | 同步校验；抛异常会阻止 execute |
| `execute(args, context)` | 异步返回 `Omit<ExternalResult, "callId" \| "source">` |

```ts
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  effects: ["read"], requiresApproval: false,
  validate(args) {
    if (!args || typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a nonempty string");
  },
  async execute(args, context) {
    return { status: "success", content: await context.services.sandbox.readText(args.path as string) };
  },
};
```

context 提供 services.sandbox/config/providers、当前 Worker/执行域、invoke/emit，以及当前 Worker 内部 graph 执行能力。通过 Sandbox 做文件、命令和网络访问；Core 不能阻止任意应用 JS 绕过协作式权限服务。

### createReadOnlyCommandTools(options?)

该函数返回 14 个普通 RegisteredTool，不会替应用注册工具或创建进程执行器。输入只开放常见只读操作，不接收任意命令行参数：

| Tool | 结构化参数 | 固定命令形式 |
| --- | --- | --- |
| `grep` | `pattern`、`paths`，可选 `recursive`、`ignoreCase`、`fixedStrings` | `grep -n ... -- pattern paths...` |
| `ls` | 可选 `path`、`all` | `ls -1 [-a] -- path` |
| `cat` | `path` | `cat -- path` |
| `find` | 可选 `path`、`name`、`type`、`maxDepth` | `find path -maxdepth ... [-type ...] [-name ...] -print` |
| `head` / `tail` | `path`，可选 `lines`（1–1,000，默认 20） | `head/tail -n lines -- path` |
| `wc` | `path`，可选 `metric`（`lines / words / bytes`） | `wc -l/-w/-c -- path` |
| `sort` | `path`，可选 `reverse`、`numeric`、`unique` | `sort [-r] [-n] [-u] -- path` |
| `uniq` | `path`，可选 `count`、`ignoreCase` | `uniq [-c] [-i] -- path` |
| `cut` | `path`、`fields`，可选单字符 `delimiter` | `cut [-d delimiter] -f fields -- path` |
| `stat` / `file` | `path` | `stat/file -- path` |
| `du` | `path`，可选 `maxDepth`（0–32，默认 1） | `du -k --max-depth=N -- path` |
| `pwd` | 无字段 | `pwd` |

路径必须是工作区相对 POSIX 路径；绝对路径、反斜杠、上级目录跳转、未知字段和原始 find 表达式都会在执行前拒绝。默认最多返回 1,000 行、64 KiB stdout 和 8 KiB stderr；配置的硬上限分别是 10,000 行、1 MiB 和 64 KiB。截断保持 UTF-8 完整，并在 `structuredContent.truncated` 中标记。

```ts
const commandTools = createReadOnlyCommandTools({ maxEntries: 200, maxOutputBytes: 32 * 1024 });
const runtime = createDitto({
  sandbox: { tools: commandTools.map(tool => tool.name), execute: true },
  sandboxExecutor,
  workers: [createInteractionWorker({ tools: commandTools })],
});
```

每次调用只执行一次 `sandbox.run({ command, args })`。非零退出返回带 `COMMAND_EXIT_NONZERO` 的 `failed` ExternalResult；启动、权限、传输和执行器异常继续抛出，不自动重试。相对路径校验只是协作式 API 边界，不能防御恶意执行器或工作区符号链接；不可信任务仍需 OS 或容器隔离。

### createWebSearchTool({ provider })

`web_search` 接收 `{ query, limit? }`。query 必须是最多 600 字符、75 个词的非空单行文本；limit 默认 5、硬上限 20。Tool 最多规范化请求数量的结果，统一为 `title / url / snippet`；标题上限 256 字符，摘要上限 2,048 字符；URL 只允许不带内嵌账号密码的 HTTP(S)，每个 URL 同时作为 Reference 输出。

```ts
const provider = createBraveWebSearchProvider({ apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY! });
const webSearch = createWebSearchTool({ provider });
const runtime = createDitto({
  sandbox: { tools: [webSearch.name], network: [provider.origin] },
  workers: [createInteractionWorker({ tools: [webSearch] })],
});
```

Registry 先检查 Tool 权限，Tool 再在调用 Provider 前检查精确网络 origin。Provider 异常或不合规结果统一为脱敏的 `failed / WEB_SEARCH_FAILED`，只调用一次。凭证、配额、重试与生命周期由应用负责，不进入 ToolCall。Brave 适配器使用 `GET /res/v1/web/search`、`X-Subscription-Token`、原生 fetch 和可配置超时；Core 不会默认注册。

### OutputSink.deliver

返回接收回执，deliveryId 必须与输入相同。示例接收端打印 JSON；真实应用可连接 UI、HTTP 或消息队列，连接与重试策略由应用负责。

```ts
export const consoleSink: OutputSink = {
  async deliver(input) {
    console.log(JSON.stringify({ id: input.deliveryId, message: input.message, artifacts: input.artifacts }));
    return { deliveryId: input.deliveryId, status: "accepted", ...(input.artifacts ? { artifacts: input.artifacts } : {}) };
  },
};
```

### createInteractionWorker(options?)

| Option | 类型 / 默认行为 |
| --- | --- |
| `tools?` | readonly RegisteredTool[] 或 ToolRegistry；缺省为空，仍注册 TOOL |
| `mcp?` | Readonly<Record<string, McpClient>> 或 McpRegistry；省略则不注册 MCP |
| `output?` | OutputSink；省略则不注册 OUTPUT |
| `concurrency?` | 正整数；每副本的并发入口限制，默认不限 |

OBSERVE 始终注册。数组/映射只在工厂构造时装入注册表；注入 Registry 时保留原对象，以支持动态插拔。工厂没有自动启用工具或网络权限。

```ts
export function setupInteraction(client: McpClient) {
  return createDitto({
    sandbox: { tools: ["read_text"], read: true, mcp: ["files"] },
    workers: [createInteractionWorker({ tools: [readTextTool], mcp: { files: client }, output: consoleSink, concurrency: 8 })],
  }); // client is already connected; the application closes it after runtime.close().
}
```

## 3. ACT.TOOL 与工具注册表

```ts
interface ToolCall { id: string; name: string; arguments: JsonObject; }
interface InteractionToolInput { call: ToolCall; }
type InteractionToolOutput = ExternalResult;
```

call.id 必须非空；name 选择已注册工具。arguments 是 JSON 参数对象，由工具 validate 校验业务格式。执行顺序为检查关联 ID → Sandbox tools 权限 → 解析工具 → validate → execute → 校验结果。Core 填充 callId=call.id、source=call.name，适配器不能覆盖这两个字段。
```ts
export async function invokeTool() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool] })] });
  try {
    const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } } });
    if (result.status !== "success") throw new Error(result.error?.code ?? result.status);
    return result.content; // Direct ExternalResult; no .output wrapper.
  } finally { await runtime.close(); }
}
```

### ToolRegistry.register / list / call

`new ToolRegistry()` 创建空注册表；`register(tool)` 返回 `() => boolean`，首次移除成功为 true，再次为 false。重复名称或非法名称立即抛错。`list(context)` 只列出 Sandbox 允许的定义，不包含执行函数；`call(call, context)` 返回 Promise<ExternalResult>。context 应来自 Worker handler，不要自行伪造权限上下文。
```ts
export async function toolRegistryApis(context: WorkerContext<unknown, unknown>) {
  const tools = new ToolRegistry();
  const unregister = tools.register(readTextTool);
  const definitions = tools.list(context); // Only tools allowed by context.services.sandbox.
  try {
    const result = await tools.call({ id: "read-1", name: "read_text", arguments: { path: "README.md" } }, context);
    return { definitions, result };
  } finally { unregister(); } // true on first removal, false afterwards; does not close tool resources.
}
```

## 4. ACT.MCP 与客户端适配

```ts
type InteractionMcpInput =
  | { operation: "discover"; server?: string }
  | { operation: "invoke"; server: string; call: ToolCall };
type InteractionMcpOutput =
  | { operation: "discover"; capabilities: readonly McpCapability[] }
  | { operation: "invoke"; result: ExternalResult };
interface McpClient {
  listTools(params?: { cursor?: string }, options?: McpCallOptions): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: JsonObject; outputSchema?: JsonObject }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: JsonObject }, options?: McpCallOptions): Promise<McpToolResult>;
}
interface McpToolResult {
  content?: MessageContent; structuredContent?: JsonValue;
  references?: readonly Reference[]; isError?: boolean; error?: InteractionError;
}
```

discover 不执行动作、不生成 Observation，也不修改 Context。省略 server 时遍历所有已注册服务；所有访问都需 Sandbox mcp 权限，遇到拒绝不会静默过滤。每个 capability 含 server、name、inputSchema，以及可选 description/outputSchema。invoke 固定使用应用指定的 server 与工具名，返回 result.source=`server:toolName`，result.callId 保持输入 ID。
```ts
export async function invokeMcp(client: McpClient, absoluteFilePath: string) {
  const runtime = setupInteraction(client);
  try {
    const discovery = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "files" });
    if (discovery.operation !== "discover") throw new Error("Expected discovery response");
    const response = await runtime.invoke("INTERACTION.ACT.MCP", {
      operation: "invoke", server: "files", call: { id: "mcp-read", name: "read_text_file", arguments: { path: absoluteFilePath } },
    });
    if (response.operation !== "invoke") throw new Error("Expected invocation response");
    return { capabilities: discovery.capabilities, result: response.result };
  } finally { await runtime.close(); }
}
```

### McpRegistry.register / execute

`new McpRegistry({ maxDiscoveryPages?, maxCapabilities? })` 默认限制一次发现请求合计 100 页、1000 项，配置须为正整数。重复 cursor、超过页数/能力数量、非法 Schema 都会失败。`register(server, client)` 要求非空且唯一的 server，返回注销函数；`execute(input, sandbox)` 同时支持 discover/invoke。注销不关闭客户端。
```ts
export async function mcpRegistryApis(client: McpClient, absoluteFilePath: string) {
  const runtime = createDitto({ sandbox: { mcp: ["files"] } });
  const mcp = new McpRegistry({ maxDiscoveryPages: 10, maxCapabilities: 200 });
  const unregister = mcp.register("files", client);
  try {
    const discovery = await mcp.execute({ operation: "discover", server: "files" }, runtime.services.sandbox);
    const result = await mcp.execute({ operation: "invoke", server: "files", call: { id: "mcp-1", name: "read_text_file", arguments: { path: absoluteFilePath } } }, runtime.services.sandbox);
    return { discovery, result };
  } finally { unregister(); await runtime.close(); }
}
```

### McpClient.listTools / callTool 接入例子

```ts
export function mcpClientAdapter(client: McpClient): McpClient {
  return {
    listTools: (params, options) => client.listTools(params, options),
    async callTool(params, options) {
      const result = await client.callTool(params, options);
      return {
        ...(result.content === undefined ? {} : { content: result.content }),
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.references === undefined ? {} : { references: result.references }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };
}
```

此包装保留客户端方法的 this 绑定及可选字段；传入的 client 已符合中立接口。原生 SDK 的联合返回类型需先适配。官方 SDK 的完整可运行例子见 [真实 MCP 脚本](../../scripts/check-interaction-mcp-live.mjs)及[接入说明](examples/guide.zh-CN.md#mcp)。Ditto 不安装 MCP SDK，不自动建立 stdio/HTTP 连接。适配器应把特定 SDK 的联合返回类型转换为 McpToolResult。isError=true 映射为 failed；没有安全错误对象时使用固定 MCP_TOOL_ERROR。

## 5. ExternalResult、OBSERVE 与消息

```ts
interface ExternalResult {
  callId: string; source: string;
  status: "success" | "failed" | "cancelled" | "timeout" | "unknown";
  content?: MessageContent; structuredContent?: JsonValue;
  references?: readonly Reference[]; error?: InteractionError; metadata?: JsonObject;
}
interface InteractionError { code: string; message: string; retryable?: boolean; }
interface Observation extends Omit<ExternalResult, "content"> { message: Message; }
interface Reference { uri: string; mediaType?: string; digest?: string; }
```

success 至少提供 content、structuredContent、references 中的一项；其他状态必须有 error。content/structuredContent/metadata 要能表示为 JSON，禁止函数、BigInt、非有限数字、循环引用与 Date/Map 等非普通对象。references 的 uri 必须非空。

### observeExternalResult / INTERACTION.OBSERVE

纯转换函数是同步 API，节点调用是异步 API。两者保留 callId/source/status/结构化数据/引用/error/metadata，并生成 role=tool、name=source 的 Message；单个文本块直接成为字符串，其他情况形成 text/json/reference 数组。失败会在消息中添加安全错误摘要；不会把失败改成 success，不会重试，也不主动更新 CONTEXT。
```ts
export async function observeApis() {
  const result = { callId: "read-1", source: "read_text", status: "success" as const, content: "file text" };
  const local = observeExternalResult({ result });
  const runtime = createDitto({ workers: [createInteractionWorker()] });
  try {
    const routed = await runtime.invoke("INTERACTION.OBSERVE", { result });
    return { local, routed }; // message = { role: "tool", name: "read_text", content: "file text" }
  } finally { await runtime.close(); }
}
```

### 公共 JSON / Message 类型

这些类型从 `@codesoul-co/ditto/contracts` 或根入口导入。INFER 的同名 Message 使用模型专用内容契约；跨 Worker 时显式映射。MCP Client 的发现返回要求每个工具带 inputSchema，公共 McpCapability 类型则将该字段标为可选。

```ts
export type JsonValue = string | number | boolean | null
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  name?: string;
}
export interface McpCapability {
  server: string; name: string; description?: string;
  inputSchema?: JsonObject; outputSchema?: JsonObject;
}
```

## 6. OUTPUT：交付请求与回执

```ts
interface InteractionOutputInput {
  deliveryId: string; message: Message; artifacts?: readonly Artifact[];
}
interface Artifact { name: string; reference: Reference; }
interface OutputReceipt {
  deliveryId: string; status: "accepted" | "rejected" | "unknown";
  artifacts?: readonly Artifact[]; error?: InteractionError; metadata?: JsonObject;
}
```

deliveryId 非空，建议由应用为一次交付生成并保留；Core 不依据它自动去重。message.role 必须为 system/user/assistant/tool，最终输出通常使用 assistant；content 必须存在，允许 JSON null、数值、对象、数组或文本。可选 name 为字符串。artifact.name 与 reference.uri 非空；Core 只传递引用，不自动写文件或上传资源。
```ts
export async function outputApi() {
  const runtime = createDitto({ workers: [createInteractionWorker({ output: consoleSink })] });
  try {
    return await runtime.invoke("INTERACTION.OUTPUT", {
      deliveryId: "report-1", message: { role: "assistant", content: { summary: "Complete", count: 2 } },
      artifacts: [{ name: "report", reference: { uri: "urn:report:1", mediaType: "application/json" } }],
    }); // { deliveryId: "report-1", status: "accepted", artifacts: [...] }
  } finally { await runtime.close(); }
}
```

accepted 仅说明接收端接受了请求；不代表已送达或已读。rejected/unknown 必须有 error。回执 ID 不一致、artifacts/metadata 非法会抛错，但不能因此推断外部交付未发生。Core 不自动重试可能重复产生外部影响的操作。

## 7. 错误、权限与配置

工具可以返回业务失败，接收端可以拒绝交付；两者均不需要伪装成功或抛出数据库原始错误。下面例子展示两种结构化失败：
```ts
export const missingRecordTool: RegisteredTool = {
  name: "lookup", inputSchema: { type: "object" }, validate() {},
  async execute() { return { status: "failed", error: { code: "NOT_FOUND", message: "No matching record", retryable: false } }; },
};
export const rejectedSink: OutputSink = {
  async deliver(input) { return { deliveryId: input.deliveryId, status: "rejected", error: { code: "DELIVERY_REJECTED", message: "The destination rejected the result" } }; },
};
```

公开 error.code 限 64 字符且匹配字母、数字、下划线、点或连字符；message 最长 512 字符，不允许换行、控制字符、凭证标记、绝对路径或堆栈。retryable 是可选布尔标记，不触发自动重试。MCP 业务错误中的不安全诊断会替换为固定消息；Tool/OUTPUT 的非法诊断会被拒绝。

| 配置内容 | 位置 |
| --- | --- |
| `tools / mcp / output / concurrency` | createInteractionWorker 构造参数 |
| `tools / mcp / read / write / execute / network` | createDitto({ sandbox }) 或已加载的共享 Sandbox env |
| `SDK endpoint / token` | 应用 env 与连接代码；不放入 Graph 输入 |
| `MCP discovery limits` | new McpRegistry({ maxDiscoveryPages, maxCapabilities }) |
| `workers.interaction YAML` | commands/webSearch 行为参数；通过 config.interaction 显式传给工厂 |

取消通过 Runtime 调用选项 signal 传入 WorkerContext，再传给工具/MCP/WebSearch Provider，不放在节点 payload 中。超时、重试和 SDK 关闭由执行器/应用负责。Runtime 停止等待不等于底层操作已停止。示例 Linux tool 通过 SandboxExecutor 显式启用真实命令，不作为 Core 默认能力；见 [Linux/macOS 工具示例](examples/interaction-tools.ts)。

## 8. 高级组合入口

### createInteractionNodes(options?)

options 只接收 `{ tools?: ToolRegistry, mcp?: McpRegistry, output?: OutputSink }`，不能在此处传工具数组或客户端映射。返回 WorkerNodes，可供 defineWorker 的 expose/resources/dispose 等能力组合。
```ts
export function interactionNodes(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp, output: consoleSink }) });
}
```

### createToolHandler / createMcpHandler / createOutputHandler

每个函数接收一个对应注册表或接收端，返回该叶子的 NodeHandler。适合只公开部分能力或替换其中一个 handler；业务校验行为与工厂相同。
```ts
export function interactionHandlers(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": createToolHandler(tools),
    "INTERACTION.ACT.MCP": createMcpHandler(mcp),
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
    "INTERACTION.OUTPUT": createOutputHandler(consoleSink),
  } });
}
```

### 节点描述符

interactionToolNode、interactionMcpNode、interactionObserveNode、interactionOutputNode 均提供 `.type` 和 `.define(workerType, handler)`，只固定语义类型，不会单独注册或执行。替换 NodeHandler 时由应用保证完整契约；通常优先使用 createInteractionWorker。
```ts
export const observationDefinition = interactionObserveNode.define("INTERACTION", async input => observeExternalResult(input));
```

## 9. Graph + Loop + Worker 与生命周期

下面在 Graph 内定义 TOOL → OBSERVE → OUTPUT，用 Loop 迭代两份文件；工具和输出的具体实现仍在 Worker 中。路径与调用 ID 是 Graph 输入，SDK 客户端和凭据不是。
```ts
export async function interactionGraph() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool], output: consoleSink })] });
  const plan = graph<{ path: string; id: string }>("read-and-deliver")
    .node("read", "INTERACTION.ACT.TOOL", [], input => ({ call: { id: input.id, name: "read_text", arguments: { path: input.path } } }))
    .node("observe", "INTERACTION.OBSERVE", ["read"], (_input, { read }) => ({ result: read }))
    .node("output", "INTERACTION.OUTPUT", ["observe"], (input, { observe }) => {
      if (observe.status !== "success") throw new Error(observe.error?.code ?? observe.status);
      return { deliveryId: `${input.id}:delivery`, message: { role: "assistant", content: observe.message.content } };
    });
  const paths = ["README.md", "package.json"];
  try {
    return await runtime.loop(loop({ graph: plan, maxIterations: paths.length,
      bind: (index: number) => ({ path: paths[index]!, id: `read:${index}` }),
      update: index => index + 1, done: index => index === paths.length,
    }), 0);
  } finally { await runtime.close(); }
}
```

同一 Worker definition 注册多次会共享传入的工具/注册表/客户端/接收端。需要独立资源时分别构造 definition，或使用 defineWorker 的 resources/dispose。动态 unregister 只移除后续查找，不取消已开始操作或关闭 SDK。关闭时先 `await runtime.close()` 排空 Worker，再关闭应用拥有的 MCP、数据库、队列等客户端。

命令、普通工具与 MCP 的组合用法见[示例指南](examples/guide.zh-CN.md)。数据库能力接入 MEMORY，不需要把数据库客户端塞进 Interaction。模型动作循环见 [ReAct Graph](../interaction-runtime.zh-CN.md#react-预定义-graph-流程)。

## 与 CONTEXT 组合

工具结果先经 OBSERVE，再通过 ingress 更新 CONTEXT。缓存模式在 Graph 中给 UPDATE 传 scope；runToolCallFlow/runMcpFlow 使用显式 Context。 [完整 CONTEXT API 与调用示例](context.zh-CN.md)。

```ts
export async function toolToCachedContext(
  runtime: import("@codesoul-co/ditto").RuntimeClient,
  scope: import("@codesoul-co/ditto/worker/context").ContextScope,
  call: import("@codesoul-co/ditto/contracts").ToolCall,
) {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call });
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result });
  // The application chooses whether failed observations should enter its working set.
  if (observation.status !== "success") throw new Error(observation.error?.code ?? observation.status);
  return runtime.invoke("CONTEXT.UPDATE", { scope, ingress: [{
    id: `observation:${call.id}`, sourceNode: "INTERACTION.OBSERVE", content: observation.message.content,
    metadata: { callId: call.id, source: observation.source, status: observation.status },
  }] });
}
```

[完整 imports 和代码](examples/context.ts)。

## Provider 取消和有界网页响应

`WebSearchProvider.search(input, options?: WebSearchCallOptions)` 的 options 为 `{ signal?: AbortSignal }`；工具自动传入 WorkerContext.signal。Brave 工厂的 maxResponseBytes 默认 1048576，允许 1–16777216；流式计数限制实际响应体，超限停止读取并关闭流，再进行 JSON 解析。timeoutMs 默认 30000，范围 1–2147483647。失败工具输出使用安全错误；取消为 WEB_SEARCH_CANCELLED，其他失败为 WEB_SEARCH_FAILED。应用需主动配置密钥及网络权限。

```ts
import { createBraveWebSearchProvider, createReadOnlyCommandTools, createWebSearchTool } from "@codesoul-co/ditto/worker/interaction";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = createBraveWebSearchProvider({
  apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY!,
  ...config.interaction.webSearch,
});
const tools = [...createReadOnlyCommandTools(config.interaction.commands), createWebSearchTool({ provider })];
// Pass tools to createInteractionWorker and explicitly configure Sandbox permissions/executor.
```

`McpClient.listTools(params?, options?: McpCallOptions)` 和 `callTool(params, options?: McpCallOptions)` 同样接收 signal；McpRegistry.execute 的第三个参数也接受它。discover 在每页前后检查取消。中立接口适配到官方 MCP SDK 时，listTools 使用第二参数，callTool 使用第三参数：`client.callTool(params, undefined, options)`；第二参数是结果 schema。完整接线见 [真实 MCP 示例](../../scripts/check-interaction-mcp-live.mjs)。自定义 RegisteredTool 可直接将 context.signal 传给 Sandbox.run 或 SDK。

本地执行器已提供正式工厂 `createLocalSandboxExecutor`，可替换为自有 SandboxExecutor；参数、权限、取消和完整例子见 [Sandbox API](runtime.zh-CN.md#sandbox-api-与本地执行器)。ReAct 的 signal 同时传入采样、动作和观察 Graph，工具可通过 context.signal 接收取消。

[工具和系统操作完整流程](tool-workflows.zh-CN.md)：模型原生工具选择与参数补全、十项应用适配器、持久化恢复与已安装包端到端验收。

[执行结果理解完整流程](observation-workflows.zh-CN.md) 组合 OBSERVE、模型解释、Context/Memory 检查点与实际后续动作工具。
