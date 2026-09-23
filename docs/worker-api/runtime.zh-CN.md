# Runtime、Graph 与 Loop API

[English](runtime.md) · [Worker API](README.zh-CN.md) · [完整示例](../../examples/runtime/README.zh-CN.md)

从 `@ditto/core` 或 `@ditto/core/runtime` 导入 Runtime API。使用顺序是定义 Graph 的节点与依赖，定义 Loop 的状态规则，注册 Worker 的具体实现，最后由 Runtime 执行。模型、数据库和工具插件仍放在对应 Worker 中。

## 通信模式与部署

| Worker 位置 | 执行方式 | 注册方式 |
| --- | --- | --- |
| 同一进程 | 直接函数调用，不序列化 | `register(definition)` |
| 同一机器、不同进程 | Node 原生 IPC，不经过 TCP | `createIpcTransport` + `registerRemote`；执行端 `serveWorkerIpc` |
| 不同机器 | HTTP(S) 请求/响应 | `createHttpTransport` + `registerRemote`；执行端 `createWorkerHttpHandler` |

Runtime 先筛选公开能力、可用状态、并发容量，然后优先同进程、同 host、跨 host；同级副本轮询。注册时将外部 Worker 绑定到具体 transport，Runtime 不会自己启动进程或推断机器地址。同一台机器上的 Runtime 应使用相同 `hostId`、不同 `processId`；机器之间使用不同 `hostId`。`workerId` 在一个 Runtime 的目录中必须唯一。

这里的本地 IPC / 网络 HTTP 是部署通信模式。`invoke` 请求/响应和 `emit` 异步事件则是通信语义：默认事件只在注入的 EventFabric 内传播，不会随 IPC/HTTP 调用自动广播。网络协议、凭据与 Artifact 详见[通信与部署](../worker-communication.zh-CN.md)。

## 创建、注册与释放

```ts
import { createDitto, createContextWorker, loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const runtime = createDitto({ config, hostId: "machine-a", processId: "agent" });
const context = runtime.register(createContextWorker({ policy: config.context.policy ?? {} }), "context-a");
try {
  console.log(runtime.workers()); // address, capabilities, available, active, concurrency
  const output = await runtime.invoke("CONTEXT.LOAD", {
    sources: [{ role: "user", content: "hello" }],
  }, { workerId: context.address.workerId });
  console.log(output);
} finally { await runtime.close(); }
```

| API | 参数与行为 |
| --- | --- |
| `createDitto(options?)` / `new DittoRuntime(options?)` | `config/providers/sandbox/sandboxExecutor` 配置默认 services；`workers` 批量注册本地定义；`hostId/processId` 为目录身份；`transports/events/artifacts/inlineLimitBytes` 注入通信资源 |
| `register(worker, idOrOptions?)` | 返回 WorkerHandle；第二参数为 ID 字符串或 `{ id?, services? }`；每次注册独立实例化 resources |
| `registerRemote({ address, capabilities, transportId, concurrency? })` | 仅登记外部 Worker；transport 必须已安装；调用端默认不限制并发，执行端仍执行自己的容量限制 |
| `workers()` | 返回状态快照，不暴露 SDK、密钥或 services |
| `handle.setAvailable(false)` | 暂停新调用路由；`true` 恢复。已开始的任务继续执行 |
| `handle.unregister()` | 移除目录登记，返回是否移除；资源仍由 handle 或 Runtime 关闭 |
| `handle.close()` | 移除登记、等待该副本已接收的调用、执行一次 dispose；重复调用返回同一个 Promise |
| `runtime.close()` | 拒绝新的顶层执行，移除本 Runtime 的事件订阅；等待已接受的 Graph/Loop/调用及事件处理，最后释放 Worker。重复调用共享同一个 Promise |

```ts
context.setAvailable(false);
context.setAvailable(true);
context.unregister();
await context.close();
```

Runtime 不拥有共享 EventFabric、transport、子进程、HTTP server 或外部数据库客户端的生命周期。应用停止入口后调用 `runtime.close()`，再释放这些资源。Worker 自己创建的资源可通过 `defineWorker({ resources, dispose, ... })` 释放。Worker/事件 handler 中不要等待所属 Runtime 的 close，否则会等待自身完成。

## Graph：定义 Node 与连接

```ts
import { graph } from "@ditto/core";
const prepare = graph<string>("prepare")
  .node("load", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }))
  .node("select", "CONTEXT.SELECT", ["load"], (_input, { load }) => ({
    context: load, purpose: "infer",
  }));
const result = await runtime.run(prepare, "Find the relevant information", {
  concurrency: 2,
  workers: { load: "context-a", select: "context-a" },
  signal: AbortSignal.timeout(30_000),
});
console.log(result.select.context);
```

`graph<I>(id?)`、`runtime.graph<I>(id?)` 和 `ExecutionGraph.create<I>(id)` 创建不可变 Graph。`.node(id, nodeType, dependencies, bind)` 返回追加节点后的新 Graph；记得保存返回值。`id` 在图内唯一；`dependencies` 只能引用此前定义的节点，无依赖表示可以并发执行；循环放到 Loop。`bind(input, outputs)` 的类型只暴露声明过的依赖，返回对应 Node 的输入。Graph 不记录 Worker ID、客户端、凭据或 host；部署绑定放到运行选项。

`runtime.run(plan, input, options?)` 返回按节点 ID 索引的结果对象。`workers` 是 `{ 图内节点ID: WorkerID }`，可只绑定部分节点，其余自动路由。未知绑定和能力不匹配在整张图开始前抛错；指定副本不可用时不自动绕过绑定。`concurrency` 限制该次 Graph 同时运行的节点数，优先级为调用参数 → YAML `runtime.graphConcurrency` → 无限制。

调度使用 O(V+E) 的依赖表和就绪队列。节点抛异常后停止启动新节点，等待已启动的分支结束再抛出首个观察到的异常。返回 `status: "failed"` 属于正常业务返回值，Graph 不会自动当成异常：在 bind 中检查并选择抛错或传递。图内输出仅做浅层冻结，不复制大型业务对象。

Worker 的 `concurrency` 是副本级上限；Graph 的并发数是每次执行的上限。直调满载会抛 `NoWorkerAvailableError`；Graph 同样不维护额外的容量等待队列。如果将多个并行节点指定到容量为 1 的副本，设置 `concurrency: 1`、增加副本或调整连接关系。并行执行多个 Graph 时，应用也应控制总入口负载。

## Loop：同一 Graph 重复、不同 Graph 切换

```ts
import { loop } from "@ditto/core";
const alternate = graph<string>("alternate")
  .node("load", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }))
  .node("select", "CONTEXT.SELECT", ["load"], (_input, { load }) => ({ context: load, purpose: "infer" }));
const workflow = loop({
  graph: (state: { round: number; text: string }) => state.round % 2 ? alternate : prepare,
  maxIterations: 4,
  bind: state => state.text,
  update: (state, output) => ({ round: state.round + 1, text: String(output.select.context.items[0]?.content ?? "") }),
  done: state => state.round >= 4,
});
const state = await runtime.loop(workflow, { round: 0, text: "hello" }, {
  concurrency: 1,
  workers: { prepare: { load: "context-a" }, alternate: { load: "context-a" } },
});
console.log(state.round); // 4
```

`loop(definition)` 返回浅层冻结定义；也可直接向 `runtime.loop` 传定义对象。`graph` 可以是固定 Graph，或根据当前 state 选择 Graph 的同步函数。每轮依次选择 Graph → bind → 执行 → update → done；至少执行一轮，done 接收到的是更新后的状态及本轮输出。不同 Graph 应满足共同的输入/输出契约；不相同的业务状态可以用带标签的联合类型表达。

`maxIterations` 优先使用定义中的值，其次 YAML `runtime.loopMaxIterations`，最后 32；必须为正安全整数。到达上限而 done 仍为 false 时抛错。执行选项里的 `workers` 按 Graph ID 分组，concurrency/signal 对整个 Loop 生效。状态留在调用端；通过 IPC/HTTP 发送的只有节点请求。不存在隐式持久化、自动重试或检查点。

## 每个 Worker 的 Sandbox 与资源

```ts
import { createRuntimeServices, createInteractionWorker } from "@ditto/core";
const services = createRuntimeServices({
  config, sandbox: { tools: ["inspect_text"], read: true },
  // sandboxExecutor: applicationContainerExecutor,
});
const reader = runtime.register(createInteractionWorker({ tools: [inspectTextTool] }), {
  id: "file-reader", services,
});
```

`inspectTextTool` 是应用的 RegisteredTool，完整实现见[示例](../../examples/runtime/graph-loop.ts)。省略 services 时共享 Runtime 默认资源。传入独立 `createRuntimeServices` 结果可以分别配置工作目录、网络/工具/读写/执行权限、ProviderRegistry 和 SandboxExecutor。工作目录属于 `services.config.workspace`，可由应用分别解析配置后注入。

HTTP Provider 在创建时绑定对应 Sandbox，不能只替换 sandbox 对象却复用拥有更宽权限的 Provider。独立 createRuntimeServices 会重新构造配置中的 HTTP Provider；应用注入的自定义 SDK/Provider 应自行遵守权限。跨 Worker 的 ctx.invoke 使用目标 Worker 自己的 services，不继承来源 Worker 的权限。跨进程/跨机器配置完全由执行端提供，Envelope 不能覆盖它们。

Sandbox 是协作式能力检查。需要隔离任意 JS、数据库 SDK 或系统命令时，在独立进程/容器中部署 Worker，并提供对应执行器；Runtime 不自动创建容器。

## Worker 执行上下文与取消

```ts
import { defineWorker } from "@ditto/core";
const loader = defineWorker({ type: "CONTEXT", nodes: {
  "CONTEXT.LOAD": async (input, ctx) => {
    ctx.signal?.throwIfAborted();
    console.log(ctx.worker.workerId, ctx.execution?.graphId, ctx.execution?.runId, ctx.execution?.nodeId);
    // Delegate to another public Worker, retaining graph scope and cancellation.
    const result = await ctx.invoke("CONTEXT.LOAD", input, { workerId: "context-a" });
    await ctx.emit({ type: "context.loaded", payload: { count: result.items.length } });
    return result;
  },
} });
```

`ctx.resources/config` 是当前 Worker 的实例资源与 Worker 配置；`ctx.services` 是其运行环境；`ctx.artifacts` 是可选 ArtifactStore。`ctx.invoke(node, input, { workerId?, signal? })` 调用公开能力，`ctx.run(internalGraph, input)` 在当前副本内执行内部 Graph，允许调用未 expose 的内部节点，不额外占用顶层并发槽。内部调用必须 await，不要把任务留到 handler 返回之后。

取消是协作式的：本地 handler 获得 `ctx.signal`，可以传给 `ctx.services.sandbox.run(command, ctx.signal)` 或 SDK。Graph/Loop 停止启动后续节点，等待已启动本地任务结束；不会强制终止任意 JS。IPC/HTTP 的 signal 或超时结束调用端等待，当前不提供远端中断协议；远端可能仍在执行。应用重试有副作用的请求时应提供业务幂等键。

## 事件 API

```ts
const unsubscribe = runtime.subscribe("context.loaded", event => { console.log(event.payload); });
await runtime.emit({ type: "context.loaded", payload: { count: 2 } });
const failures = await runtime.drainEvents();
for (const failure of failures) console.error(failure.event.type, failure.error);
unsubscribe();
```

`emit` 确认事件提交，不等待所有消费者；`subscribe` 返回仅移除该订阅的函数；`drainEvents` 等待 EventFabric 当前接受的处理，并取走失败记录。共享 Fabric 的 drain 覆盖共享消费者。默认 `LocalEventFabric` 是进程内异步分发；需要消息中间件时实现 `EventFabric` 的 emit/subscribe/drain 三个方法并注入。

## 本地 IPC 与远端 HTTP API

```ts
import { createIpcTransport, serveWorkerIpc } from "@ditto/core";
// Parent process; child comes from node:child_process.fork(...).
const ipc = createIpcTransport({ id: "local-ipc", channel: child, timeoutMs: config.timeoutMs });
const app = createDitto({ hostId: "machine-a", transports: [ipc] });
app.registerRemote({ address: childAddress, capabilities: ["CONTEXT.LOAD"], transportId: ipc.id, concurrency: 4 });
await app.invoke("CONTEXT.LOAD", { sources: [] });
await app.close();
ipc.close(); // Parent separately shuts down its child.

// Child process: register local Workers first.
const receiver = serveWorkerIpc(workerRuntime, process);
await receiver.close(); // Stop intake and await accepted replies when shutting down.
await workerRuntime.close();
```

`IpcChannel` 对接 Node 的 `ChildProcess` 或启用 IPC 的 `process`；只有父子进程已有 IPC channel 时可用。`createIpcTransport` 的 timeoutMs 默认 30000，范围 1–2147483647。请求用 invocation ID 关联；超时、取消、disconnect、close 都会清理等待者和监听器。运行错误返回通用消息，业务输出保持 Node 原契约。IPC 不使用网络 token，也不应把该接口暴露给不可信来源。

```ts
import { createHttpTransport, createWorkerHttpHandler } from "@ditto/core";
const http = createHttpTransport({ id: "remote", url: endpoint, token, timeoutMs: config.timeoutMs });
const app = createDitto({ hostId: "machine-a", transports: [http] });
app.registerRemote({ address: remoteAddress, capabilities: ["CONTEXT.LOAD"], transportId: http.id });
// Server: createServer(createWorkerHttpHandler(workerRuntime, { token })).listen(...)
```

HTTP transport 要求非空 id；timeoutMs 默认 30000，范围 1–2147483647，构造时校验。 HTTP handler 使用 `/ditto/invoke`；默认请求/响应上限 1 MiB，可用 maxBodyBytes 调整。服务端和调用端的 token 必须一致；跨机器生产部署使用 HTTPS。完整启动、地址交换、Graph 调用和关闭代码见 [placement.ts](../../examples/runtime/placement.ts)。`receive(envelope)` 是通信适配器的接收边界，校验目标身份与公开能力；应用业务调用应使用类型化的 invoke/run。

Artifact 的 `InMemoryArtifactStore`、`PayloadCodec` 和可替换存储接口见[通信文档](../worker-communication.zh-CN.md#invokeemit-与-artifact)。现有 `runRagFlow/runSkillFlow/runToolCallFlow/runMcpFlow/runReactFlow` 的组合调用继续适用，见 [Interaction 使用 API](interaction.zh-CN.md)。

## 内置 Worker 的取消传递

本地执行时，Runtime signal 传递到 INFER 模型 Provider、MEMORY 数据库适配器、CONTEXT 服务、RETRIEVAL 流水线及 INTERACTION 的工具/MCP 客户端。SDK 适配器需要继续将 signal 交给支持取消的底层实现。取消不会撤销已完成的副作用。Graph/Loop 关闭仍等待已接收的任务收尾；Worker 内部的 ctx.invoke 可在收尾期间完成既有委托。网络与 IPC 传输目前只取消调用方等待，不提供远端任务取消协议。

## Sandbox API 与本地执行器

从 `@ditto/core/runtime/sandbox` 或根包导入；这些是可执行实现及可替换接口，不要求额外进程管理依赖。

| API | 参数与行为 |
| --- | --- |
| new Sandbox(workspace, policy?, executor?) | 工作目录转绝对路径；复制并冻结权限；默认全部拒绝。read/write/execute 必须为布尔值，tools/mcp/skills/network 为非空字符串数组 |
| allows(kind, name) | 同步 boolean；四类命名权限支持精确匹配或 `*` |
| assert(kind, name) | 不允许时抛 PermissionDeniedError |
| readText(path, signal?) | UTF-8 读取；要求 read 权限，拒绝工作区外路径及指向区外的符号链接 |
| writeText(path, content, signal?) | UTF-8 覆盖/创建文件；要求 write 权限及已有父目录，拒绝区外和悬空符号链接；不自动建目录 |
| run({ command, args }, signal?) | 要求 execute=true 和注入执行器；复制参数、解析真实工作目录，执行前后检查取消，返回 stdout/stderr/exitCode |
| createLocalSandboxExecutor(options) | 显式创建本地主机命令执行器，供 Sandbox 或 Runtime services 注入 |

LocalSandboxExecutorOptions：commands 必填，为可执行文件名或绝对路径的精确白名单，空数组禁用所有命令；不接受相对路径命令。timeoutMs 默认 5000，范围 1–2147483647 ms；maxOutputBytes 默认 65536，范围 1–16777216，为 stdout 与 stderr 合计 UTF-8 字节数。env 是显式注入的字符串映射，默认只有 PATH=/usr/bin:/bin；不继承父进程凭据或隐式 Node 覆盖率配置，操作系统自身可能补充环境变量。构造时快照白名单、环境和限额。

执行使用 spawn、shell=false、独立参数和关闭的 stdin；非零退出返回真实 exitCode。启动失败 reject；超时、取消、输出超限终止直接子进程并关闭输出流，等待其关闭后 reject。超过输出上限不会返回截断后的成功结果。已完成的写文件或外部副作用不会因取消自动回滚。

```ts
import { Sandbox, createLocalSandboxExecutor } from "@ditto/core/runtime/sandbox";
import { loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const executor = createLocalSandboxExecutor({
  commands: ["uname", "printf"], ...config.sandboxExecution,
});
const sandbox = new Sandbox(config.workspace, {
  read: true, write: true, execute: true, tools: ["inspect"],
}, executor);
console.log(sandbox.allows("tools", "inspect")); // true
sandbox.assert("tools", "inspect");
const signal = AbortSignal.timeout(3000);
await sandbox.writeText("example.txt", "hello", signal);
console.log(await sandbox.readText("example.txt", signal));
const result = await sandbox.run({ command: "printf", args: ["%s", "$(uname) stays literal"] }, signal);
console.log(result); // { stdout: "$(uname) stays literal", stderr: "", exitCode: 0 }
```

Runtime 可使用 `createDitto({ config, sandbox: { execute: true }, sandboxExecutor: executor })`；每 Worker 也可通过 createRuntimeServices 注入不同执行器。容器/远端适配器继续实现 `SandboxExecutor.run(command, { workspace, signal? })`，无需改变 Graph/Tool。

这是协作式能力边界；本地进程及其衍生进程不受 OS 文件/网络隔离，命令白名单也不限制命令参数可访问的文件。终止直接子进程不承诺终止它产生的整个进程树。不可信代码需由外部 OS/容器执行器提供真正隔离。可运行的 Linux/macOS 工具组合见 [interaction-tools.ts](../../examples/interaction-tools.ts)。

自定义 Worker/节点、资源生命周期、事件和 Artifact 详见 [组合 API](composition.zh-CN.md)；预定义流程详见 [流程 API](flows.zh-CN.md)。
