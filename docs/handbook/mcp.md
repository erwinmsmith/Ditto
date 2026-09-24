# MCP：连接外部工具服务

MCP 接入分成三层：应用建立 SDK 连接；中立适配器符合 Ditto 的 McpClient；Graph 调用 `INTERACTION.ACT.MCP`。Ditto 不捆绑 MCP SDK，也不根据 server 名称自动启动进程。

## 1. 安装应用依赖

在自己的 npm 应用中：

```sh
npm install @codesoul-co/ditto @modelcontextprotocol/sdk @modelcontextprotocol/server-filesystem
mkdir -p workspace
printf 'Hello from MCP\n' > workspace/hello.txt
node examples/handbook/mcp.mjs ./workspace hello.txt .
```

最后一个参数是安装可选 SDK 的应用目录。可直接运行下面的完整 `.mjs` 文件；它会启动本地 filesystem server，发现工具，实际读取文件，再转换为 Observation。

若在源码仓库中，不要把这两个 SDK 加入框架的 runtime dependencies；单独创建依赖目录，安装后将该目录作为最后一个参数传入。

## 2. 完整连接和 Graph

<<< ../../examples/handbook/mcp.mjs

成功结果保留 `source: "files:read_text_file"` 与原始 callId，message 中包含实际文件内容。文件不存在时程序失败，不伪装为成功的空文本。

## 3. 为什么需要适配器

| 接口 | Ditto 期望 | 应用需要处理 |
| --- | --- | --- |
| listTools(params, options) | 工具列表与可选 nextCursor | 保留 SDK 的 this，传递 signal，映射 inputSchema |
| callTool(params, options) | content / structuredContent / references / isError | 官方 SDK 的第三参数才是调用 options；第二参数是结果 schema |
| close | 不属于 McpClient | 由应用在 Runtime 排空后关闭客户端与 transport |

官方 SDK 的内容块可能含特定多模态类型。文本/JSON/引用之外的内容应明确归一化或保留为应用允许的引用，不能把不兼容的联合类型直接强制断言后塞入通用 Message。

## 4. discover 和 invoke 的返回值不同

`{operation:"discover",server:"files"}` 返回 capabilities；`{operation:"invoke",server:"files",call:{...}}` 返回 result。先检查 discriminant `operation`，再访问字段。`result` 是 ExternalResult，不是 NodeResult。

discover 会处理分页。McpRegistry 默认限制总页数与总工具数，拒绝重复 cursor 和非法 schema。大型 server 可显式设定 `maxDiscoveryPages/maxCapabilities`，仍应保持有界。

## 5. 权限和边界

Sandbox 的 `mcp: ["files"]` 控制允许的 server，不会自动限制该 server 内每个工具。示例的文件根目录由 filesystem server 自己限制。若只允许读工具，需要在适配器的 listTools/callTool 中过滤并拒绝其他名称。

远端 HTTP MCP 的认证、TLS、session 续期与连接配置由对应 SDK transport 管理。主机地址和 token 由可信控制器配置，不从模型动作参数直接采用。HTTP transport 接好后仍可复用相同 Graph 和中立适配器。

## 6. 加入 Agent 循环

第一次加载或 server 能力变化时 discover，将允许动作映射为模型的 action descriptors。INFER 返回的动作只包含调用意图；校验 server/name/schema 后由 MCP Graph 执行。OBSERVE 结果写入 Context，然后 Loop 决定继续、返回或升级人工。

一个 callId 应关联一次逻辑调用；有副作用时另外提供服务支持的幂等标识。MCP transport 超时不保证 server 回滚，恢复时仍需核对效果。

[逐接口 MCP API](../worker-api/interaction.zh-CN.md) · [真实 MCP 测试脚本](../../scripts/check-interaction-mcp-live.mjs) · [ReAct](../../examples/patterns/react/README.zh-CN.md)
