# Worker 通信与部署

[English](worker-communication.md) · **简体中文**

> Runtime 的 `invoke` / `emit` 是内部通信语义，不属于 Interaction Node。`INTERACTION.RUN` 已移除；应用 Graph 与 Loop 调用公开的叶子能力，Loop 和状态留在调用端。

## 位置与调用

| 位置 | 当前实现 | 数据与执行 |
| --- | --- | --- |
| 同进程 | 直接调用 Worker executor | 保留对象身份，不序列化 |
| 同机不同进程 | HTTP loopback，或自行实现 InvokeTransport | 序列化公开 Node 调用；路由优先于跨 host |
| 跨服务器 | HTTP(S) transport + 接收 handler | 认证、Envelope 校验、响应关联、大小与超时限制 |

`ctx.invoke` 和顶层 `runtime.invoke` 使用同一个能力路由。HTTP Adapter 使用标准库，不依赖 Express 等框架；worker_threads / MessagePort / NATS 等需要提供自己的 `InvokeTransport`。HTTP 是实际可用的网络适配器，测试通过真实 loopback socket 验证。

## HTTP 示例

以下为两个进程各自的启动代码，按部署配置交换注册地址。公开 Node 实现及内部 Graph 需要事先部署到执行端。

服务端：

```ts
import { createServer } from "node:http";
import { createDitto, defineWorker, loadRuntimeConfig, createWorkerHttpHandler } from "@ditto/core";

const token = process.env.DITTO_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_WORKER_TOKEN");
const runtime = createDitto({ hostId: "server-a", processId: "agent-service", config: loadRuntimeConfig() });
const worker = runtime.register(defineWorker({
  type: "memory", concurrency: 8, expose: ["MEMORY.RETRIEVE"],
  nodes: {
    "MEMORY.RETRIEVE": async ({ selector }) =>
      selector.ids?.map((id) => ({ id, message: { role: "assistant", content: `memory:${id}` } })) ?? [],
  },
}), "memory-a");
const server = createServer(createWorkerHttpHandler(runtime, { token }));
server.listen(8080, "127.0.0.1");
console.log(worker.address); // 通过部署配置传给调用端；不含 Key
```

调用端：

```ts
import { createDitto, createHttpTransport } from "@ditto/core";

const token = process.env.DITTO_WORKER_TOKEN;
if (!token) throw new Error("Set DITTO_WORKER_TOKEN");
const transport = createHttpTransport({
  id: "server-a-http", url: "http://127.0.0.1:8080/ditto/invoke", token, timeoutMs: 30_000,
});
const runtime = createDitto({ hostId: "client", transports: [transport] });
runtime.registerRemote({
  address: { workerId: "memory-a", workerType: "memory", hostId: "server-a", processId: "agent-service" },
  capabilities: ["MEMORY.RETRIEVE"], transportId: transport.id,
});
try {
  console.log(await runtime.invoke("MEMORY.RETRIEVE", { selector: { ids: ["example"] } }));
} finally { await runtime.close(); }
```

跨服务器将地址换为受控 HTTPS 入口，在服务前配置 TLS 或使用 Node HTTPS Server；明文 loopback 示例用于本机开发。为多个服务器分别安装 transport，再注册各自地址。相同 capability 会自然参与路由，无需改变 Graph。

相同注册方式适用于 `runtime.run()` 与 `runtime.loop()`。Loop 可每轮选择不同 DAG，只有该 DAG 的 Node 调用经过 HTTP。部署并公开所有可能选中 Graph 所需的能力。生成使用服务端模型配置；需要工具的应用还需部署 Interaction 能力，并让模型可见工具 schema 与执行权限保持一致。远端注册不会上传 Graph 函数或 Loop 状态机。

## 协议与责任

请求包含 invocation ID、源/目标 Worker 地址、Node 名称、payload，以及可选的 Graph/run/task 标识。响应 ID 必须匹配。HTTP 请求使用 `x-ditto-protocol: 1`、Bearer token，默认 body 上限 1 MiB；拒绝重定向以避免认证头流向其他地址。

接收 handler 验证 Envelope 形状；Runtime 再验证目标 host/process/type/id、公开能力与可用状态。业务 input 的语义校验仍由 Node/工具执行器承担；TypeScript 声明不是对网络输入的运行时校验。HTTP 错误不返回 handler 堆栈或 Provider 响应正文。

Token 是服务级凭证，可调用该服务 Runtime 内所有公开能力，不是租户或单 Node ACL。外部请求应通过应用自己的认证/租户网关；限制公开入口用 `expose`。执行端使用自己的 Provider Key、模型与 Sandbox 配置，调用端不能通过 Envelope 覆盖这些设置。业务输入本身仍可能包含敏感内容，应按应用需要管理日志和存储。

不自动重试：超时/断线意味着调用结果未知，远端可能仍在执行或已经完成副作用。HTTP 客户端超时只结束等待，不提供远端取消、去重、事务或 exactly-once。上层如要重试副作用，须提供业务幂等键和持久化结果表。远端满载目前返回通用失败，调用端没有自动故障转移或健康探测。

服务停止时先停止接收新 HTTP 请求，等待应用顶层任务，再关闭 Runtime 和 Server；MCP、Provider 外部连接由拥有者关闭。`registerRemote` 只是本地目录登记，不会启动服务器或把 Worker 代码复制到另一台机器。

## invoke、emit 与 Artifact

`invoke` 是请求/响应；`emit` 是向 EventFabric 提交事件。默认 LocalEventFabric 是本进程异步 fan-out，emit 返回仅代表已接受。`drainEvents()` 返回消费失败记录；Runtime.close 不自动关闭共享 EventFabric。跨服务器 Pub/Sub 需要注入外部 EventFabric，与请求 transport 分离；HTTP invoke 不会隐式转发事件。

跨传输 payload 有 `inline` 和 `reference` 两种。配置 ArtifactStore 后，超过 inlineLimitBytes（默认 64 KiB）的 JSON 数据可卸载为引用；响应也同样处理。同进程直接调用不做大小扫描。

InMemoryArtifactStore 仅适用于单进程实验。跨主机引用需要两端可访问的外部 Store/Resolver；访问控制、TTL 与清理由存储实现负责。自动生成的引用不会自动回收。无共享 Store 时保持 inline 并设置适当 body 上限。当前网络边界只支持 JSON 可编码输入输出，不支持任意 class、函数、undefined 或二进制流。
