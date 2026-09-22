# Runtime 完整示例

[English](README.md) · [全部示例](../README.zh-CN.md) · [详细 API](../../docs/worker-api/runtime.zh-CN.md)

在根目录执行，要求 Node 24+、npm 11+；首次先运行 `npm ci`。两个示例均使用现有包导出，不需要模型密钥、数据库或额外 SDK。导入示例也会执行入口代码。

| 文件 | 内容 | 命令 |
| --- | --- | --- |
| [graph-loop.ts](graph-loop.ts) | 定义 read/count 两张图；Loop 先读取 README，再重复执行 count 图两次；将节点绑定到不同 Worker，分别配置 Sandbox；通过事件输出计数 | `npm run example:runtime` |
| [placement.ts](placement.ts) | 一张 CONTEXT.LOAD Graph，依次使用同进程直调、真实子进程 IPC、另一个真实子进程的 HTTP 服务执行；包含地址交换和资源关闭 | `npm run example:runtime:placement` |

`graph-loop.ts` 真正读取根目录 README.md；reader 只允许 read_text 与文件读取，counter 只允许 count_text，无文件读写/执行权限。控制台输出两条 counted 事件与 iteration=3 的最终状态，字符数随 README 改变。Graph 只描述依赖；运行时 `workers` 映射选择具体 Worker。示例显式读取根目录 YAML 的行为默认值，使用代码里的 Sandbox 权限，不加载 `.env`。

`placement.ts` 输出两个子进程 PID，以及 direct/ipc/http 三组 Context。IPC 请求使用 Node 父子进程 channel；HTTP 请求使用带临时 token 的真实 loopback socket，启动消息和关闭消息才使用父子进程控制 channel。它验证网络协议，但不会连接两台真实机器。跨机器部署时，将 HTTP Worker 分开启动，把其注册地址和 HTTPS endpoint 配到调用端；复用原 Graph 即可。

生产连接凭据放在 `.env`，共享根目录 YAML 管理 graphConcurrency、loopMaxIterations 等行为参数。注入 SandboxExecutor 可把工具执行交给容器或其他执行环境；进程隔离和 Sandbox 权限检查各自发挥作用。
