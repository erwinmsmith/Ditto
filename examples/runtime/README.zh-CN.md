# Runtime 完整示例

[English](README.md) · [全部示例](../README.zh-CN.md) · [详细 API](../../docs/worker-api/runtime.zh-CN.md)

在根目录执行，要求 Node 24+、npm 11+；首次先运行 `npm ci`。以下本地入口使用公开包导出，无需模型密钥、数据库或额外 SDK。graph-loop/placement 导入即执行；quickstart/api/flows 仅直接运行时执行入口。flows 的 MCP/ReAct 导出函数需另行注入外部服务。

| 文件 | 内容 | 命令 |
| --- | --- | --- |
| [quickstart.ts](quickstart.ts) | YAML 行为配置、CONTEXT.LOAD → SELECT、运行和关闭 | `npm run example:runtime:quickstart` |
| [api.ts](api.ts) | 自定义 Node/Worker、私有 Graph、独立副本、事件失败、Artifact/Codec 与清理 | `npm run example:runtime:api` |
| [flows.ts](flows.ts) | Skill 加载、真实文本 RAG、README 工具读取；另提供 MCP/ReAct 调用函数 | `npm run example:runtime:flows` |
| [graph-loop.ts](graph-loop.ts) | 定义 read/count 两张图；Loop 先读取 README，再重复执行 count 图两次；将节点绑定到不同 Worker，分别配置 Sandbox；通过事件输出计数 | `npm run example:runtime` |
| [placement.ts](placement.ts) | 一张 CONTEXT.LOAD Graph，依次使用同进程直调、真实子进程 IPC、另一个真实子进程的 HTTP 服务执行；包含地址交换和资源关闭 | `npm run example:runtime:placement` |

`graph-loop.ts` 真正读取根目录 README.md；reader 只允许 read_text 与文件读取，counter 只允许 count_text，无文件读写/执行权限。控制台输出两条 counted 事件与 iteration=3 的最终状态，字符数随 README 改变。Graph 只描述依赖；运行时 `workers` 映射选择具体 Worker。示例显式读取根目录 YAML 的行为默认值，使用代码里的 Sandbox 权限，不加载 `.env`。

`placement.ts` 输出两个子进程 PID，以及 direct/ipc/http 三组 Context。IPC 请求使用 Node 父子进程 channel；HTTP 请求使用带临时 token 的真实 loopback socket，启动消息和关闭消息才使用父子进程控制 channel。它验证网络协议，但不会连接两台真实机器。跨机器部署时，将 HTTP Worker 分开启动，把其注册地址和 HTTPS endpoint 配到调用端；复用原 Graph 即可。

生产连接凭据放在 `.env`，共享根目录 YAML 管理 graphConcurrency、loopMaxIterations 等行为参数。注入 SandboxExecutor 可把工具执行交给容器或其他执行环境；进程隔离和 Sandbox 权限检查各自发挥作用。

## 新增文件的函数

| 函数 | 作用 |
| --- | --- |
| quickstart | 运行并检查 LOAD → SELECT 返回值 |
| textWorker / simpleTextWorker | defineWorker 与 extendWorker 两种真实文本处理定义 |
| workerLifecycle | 注册两个副本，验证私有节点与资源隔离，处理事件，暂停/注销/关闭 |
| eventFabric | 执行多个事件消费者，收集失败，取消订阅 |
| artifacts | put/get/delete、inline/reference 编解码与回收 |
| readTextTool / contextFlows | 注册文件读取工具，执行 Skill → 文本检索 → 工具 → 观察 → Context |
| mcpFlows | 用已连接 MCP 客户端先发现，再调用指定工具并更新 Context |
| reactFlow | 用已配置模型与 readTextTool 执行有界 ReAct；非 completed 抛异常 |
