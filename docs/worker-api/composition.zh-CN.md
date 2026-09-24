# Worker 组合、事件与 Artifact API

[English / 简体中文](composition.md) · [Runtime](runtime.zh-CN.md) · [API](README.zh-CN.md)

本页覆盖构建应用所需的扩展接口。Graph/Loop、部署、取消和 Sandbox 见 [Runtime API](runtime.zh-CN.md)，配置读取见 [配置 API](configuration.zh-CN.md)。所有示例使用公开包入口，完整代码在 [api.ts](examples/runtime/api.ts)，执行 `npm run example:runtime:api`。导入文件不会运行请求。

## Node 与 Worker 定义

`NodeContract<I, O>` 声明输入输出，`NodeContractMap` 通过 TypeScript declaration merging 扩展。`NodeType` 是已声明键的联合，`InputOf<N>` / `OutputOf<N>` 推导数据类型。契约不自动生成 handler 或运行时参数校验；handler 应验证来自网络的输入。

| API | 参数、返回与行为 |
| --- | --- |
| `defineNode<N, R, C>(workerType, type, execute)` | 返回不可变 NodeDefinition，含 workerType/type/execute；handler 为 `(input, ctx) => Promise<OutputOf<N>>` |
| `createNodeScaffold(type)` | 返回 type/define 描述符；`.define<R,C>(workerType, handler)` 与 defineNode 等价，不自动注册 |
| `defineWorker<R,C>(options)` | 创建可复用 WorkerDefinition；至少实现并公开一个节点；归属和节点键必须匹配 |
| `extendWorker<T,R,C>(type, options)` | nodes 使用相对操作名，内部补上 `${type}.`；创建新定义，不修改已有 Worker |
| `definition.type/capabilities/nodeTypes/concurrency` | 部署类型、公开节点、所有实现节点、可选并发上限；供注册与路由使用 |
| `definition.instantiate()` | 返回 WorkerExecutor，其 execute(node,input,context) 分派到 handler，dispose 释放资源；正常应用让 runtime.register 管理这些调用 |

`WorkerOptions`：`type/nodes` 必填，`resources?: () => R` 每次注册调用一次，`config?: C` 是业务配置；声明 R/C 时相应字段必填。`concurrency` 为正整数，默认无限；`expose` 省略时公开全部节点；`dispose(resources)` 可异步。resources 工厂本身同步，可在资源中存放连接 Promise 并在 handler 中 await。共享 SDK 由应用关闭，副本专用 SDK 可在 dispose 中关闭。

以下示例导入：

```ts
import assert from "node:assert/strict";
import type { NodeContract } from "@codesoul-co/ditto/contracts";
import { createNodeScaffold, defineNode, defineWorker, extendWorker } from "@codesoul-co/ditto/worker";
import {
  createDitto, graph, InMemoryArtifactStore, LocalEventFabric,
  NoWorkerAvailableError, PayloadCodec,
} from "@codesoul-co/ditto/runtime";
```

```ts
declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "EXAMPLE.TEXT.NORMALIZE": NodeContract<{ text: string }, { text: string; calls: number }>;
    "EXAMPLE.TEXT.PROCESS": NodeContract<{ text: string }, { text: string; calls: number }>;
  }
}

type Resources = { calls: number };
type Config = { prefix: string };
const internal = graph<string>("normalize-internal")
  .node("normalized", "EXAMPLE.TEXT.NORMALIZE", [], text => ({ text }));

export function textWorker(onDispose: (calls: number) => void) {
  const normalize = createNodeScaffold("EXAMPLE.TEXT.NORMALIZE").define<Resources, Config>(
    "text", async ({ text }, ctx) => {
      ctx.signal?.throwIfAborted();
      if (typeof text !== "string") throw new TypeError("text must be a string");
      return { text: `${ctx.config.prefix}${text.trim().toUpperCase()}`, calls: ++ctx.resources.calls };
    },
  );
  const processText = defineNode<"EXAMPLE.TEXT.PROCESS", Resources, Config>(
    "text", "EXAMPLE.TEXT.PROCESS", async ({ text }, ctx) => {
      const output = await ctx.run(internal, text);
      await ctx.emit({ type: "text.processed", payload: output.normalized });
      return output.normalized;
    },
  );
  return defineWorker<Resources, Config>({
    type: "text", concurrency: 2,
    resources: () => ({ calls: 0 }), config: { prefix: "Ditto: " },
    expose: ["EXAMPLE.TEXT.PROCESS"],
    nodes: { "EXAMPLE.TEXT.NORMALIZE": normalize, "EXAMPLE.TEXT.PROCESS": processText },
    dispose: resources => onDispose(resources.calls),
  });
}
```

两个节点属于同一个 `text` Worker；只有 PROCESS 对外公开。PROCESS 用 ctx.run 调用私有 NORMALIZE，共享本副本计数与配置。注册两次得到独立计数。`config` 不深拷贝，应用应保持其不可变。

短名称写法：

```ts
export function simpleTextWorker() {
  return extendWorker<"EXAMPLE.TEXT">("EXAMPLE.TEXT", {
    nodes: {
      NORMALIZE: async ({ text }) => {
        if (typeof text !== "string") throw new TypeError("text must be a string");
        return { text: text.trim().toUpperCase(), calls: 1 };
      },
    },
  });
}
```

## WorkerContext 与生命周期

| 字段 / 方法 | 调用用途 |
| --- | --- |
| `ctx.resources`, `ctx.config` | 当前副本资源、定义提供的业务配置 |
| `ctx.services` | config/providers/sandbox；由 Runtime 或注册时的 services 提供 |
| `ctx.worker`, `ctx.execution` | WorkerAddress；可选 graphId/runId/nodeId；普通顶层 invoke 无 Graph scope |
| `ctx.signal` | 本地协作取消信号；转交 SDK 或 Sandbox 方法 |
| `ctx.run(plan,input)` | 在当前副本运行内部 Graph；可访问私有节点，不再次占入口并发配额 |
| `ctx.invoke(node,input,options?)` | 按公开能力路由；可传 workerId/signal；继承执行 scope 与取消信号 |
| `ctx.emit(event)` | 提交事件，await 表示接受，不表示消费者完成 |
| `ctx.artifacts` | 可选 ArtifactStore，只有 runtime 配置后存在 |

WorkerContext 也实现 RuntimeClient（invoke/emit），可传给预定义 Context 流程。handler 必须 await 内部工作，不在自身执行中等待自己的 handle.close/runtime.close。NodeDefinition/WorkerDefinition 是定义；只有 register 后才参与 Runtime 调度。

下面验证私有节点不可从外部路由、两个副本资源独立、暂停/恢复、注销和幂等关闭：

```ts
export async function workerLifecycle() {
  const disposed: number[] = [];
  const runtime = createDitto();
  const definition = textWorker(calls => { disposed.push(calls); });
  const first = runtime.register(definition, "text-a");
  const second = runtime.register(definition, { id: "text-b" });
  const events: unknown[] = [];
  const unsubscribe = runtime.subscribe("text.processed", event => { events.push(event.payload); });
  try {
    const plan = runtime.graph<string>("text-entry")
      .node("result", "EXAMPLE.TEXT.PROCESS", [], text => ({ text }));
    const output = await runtime.run(plan, " hello ", { workers: { result: "text-a" } });
    assert.deepEqual(output.result, { text: "Ditto: HELLO", calls: 1 });
    const replica = await runtime.invoke("EXAMPLE.TEXT.PROCESS", { text: "world" }, { workerId: "text-b" });
    assert.equal(replica.calls, 1); // Separate resources for each registration.
    await assert.rejects(runtime.invoke("EXAMPLE.TEXT.NORMALIZE", { text: "private" }), NoWorkerAvailableError);
    second.setAvailable(false);
    assert.equal(runtime.workers().find(worker => worker.address.workerId === "text-b")?.available, false);
    await assert.rejects(runtime.invoke("EXAMPLE.TEXT.PROCESS", { text: "paused" }, { workerId: "text-b" }), NoWorkerAvailableError);
    second.setAvailable(true);
    assert.equal(second.unregister(), true); // Resources still exist until close.
    assert.equal(disposed.length, 0);
    await second.close();
    assert.deepEqual(await runtime.drainEvents(), []);
    assert.equal(events.length, 2);
    assert.equal(unsubscribe(), true);
    await first.close();
    return { output: output.result, events, disposed };
  } finally {
    unsubscribe();
    await runtime.close(); // Idempotent; both handles are already closed on success.
    assert.deepEqual(disposed, [1, 1]);
  }
}
```

`NoWorkerAvailableError` 的 node 字段指出无法分配的语义节点：未注册、私有、暂停或全部满载都可能触发。没有隐式排队或重试。Graph 的业务失败对象仍是普通输出；应用检查 status 后决定是否 throw。`unregister()` 不释放资源，之后仍需 close。

## EventFabric

`new LocalEventFabric()` 可用 `createDitto({ events })` 注入。`RuntimeEvent<T>` 为 `{type,payload}`；`subscribe(type, handler)` 按完整 type 匹配，返回取消函数（首次移除 true，再次 false）。`emit(event)` 接受后返回，各消费者独立执行；`drain()` 等待已提交工作（包括消费者继续 emit 的工作），返回并清空 `{event,error}[]`。对应 Runtime 方法是 emit/subscribe/drainEvents。

```ts
export async function eventFabric() {
  const events = new LocalEventFabric();
  const seen: unknown[] = [];
  const unsubscribe = events.subscribe("job.done", event => { seen.push(event.payload); });
  const unsubscribeFailure = events.subscribe("job.done", () => { throw new Error("consumer unavailable"); });
  await events.emit({ type: "job.done", payload: { id: "job-1" } });
  const failures = await events.drain();
  assert.equal(failures.length, 1);
  assert.deepEqual(seen, [{ id: "job-1" }]);
  assert.deepEqual(await events.drain(), []); // Failure records have been consumed.
  unsubscribe();
  unsubscribeFailure();
  return { seen, failedConsumers: failures.length };
}
```

LocalEventFabric 是进程内异步广播，无持久化、跨机传递、容量限制或投递重试。应用应限制生产速率并定期 drain。自定义 EventFabric 只需实现 emit/subscribe/drain 三个方法；Runtime.close 不关闭外部共享总线。HTTP/IPC invoke 与事件系统独立。

## ArtifactStore 与 PayloadCodec

| API | 输入、输出与语义 |
| --- | --- |
| `new InMemoryArtifactStore()` | 进程内 Map，无 TTL/容量限制/持久化 |
| `store.put(value)` | `Promise<Reference>`，生成 ditto://artifact/... URI；保存原对象引用 |
| `store.get(reference)` | `Promise<unknown>`；不存在时抛错，调用者检查数据类型 |
| `store.delete(reference)` | `Promise<boolean>`，返回是否存在并已删除 |
| `new PayloadCodec(store?, inlineLimitBytes?)` | 默认 65536 字节；阈值为有限非负数 |
| `codec.encode(value)` | `Promise<Payload>`；有 store 且 JSON UTF-8 字节数大于阈值时返回 reference，否则 inline |
| `codec.decode(payload)` | inline 直接返回 value；reference 使用 store.get，无 store 则抛错 |

```ts
export async function artifacts() {
  const store = new InMemoryArtifactStore();
  const value = { text: "x".repeat(100) };
  const reference = await store.put(value);
  assert.strictEqual(await store.get(reference), value); // No clone or persistence.
  assert.equal(await store.delete(reference), true);
  assert.equal(await store.delete(reference), false);
  await assert.rejects(store.get(reference), /Artifact not found/);

  const codec = new PayloadCodec(store, 32);
  const small = await codec.encode({ text: "ok" });
  const large = await codec.encode(value);
  assert.equal(small.kind, "inline");
  assert.equal(large.kind, "reference");
  assert.deepEqual(await codec.decode(small), { text: "ok" });
  assert.deepEqual(await codec.decode(large), value);
  if (large.kind === "reference") await store.delete(large.reference);
  return { small: small.kind, large: large.kind };
}
```

接入 Runtime：`createDitto({ artifacts: store, inlineLimitBytes: 65536 })`。同进程直调不编码；传输边界才使用 codec。跨进程两端需要能访问同一外部存储，不能各自创建 InMemoryArtifactStore 期望共享。Core 不回收传输产生的引用；应用/存储负责清理、访问控制和有效期。Payload 引用也不会自动注册为 CONTEXT ReferenceResolver，两者按需显式对接。

## 自定义通信适配

优先使用已提供的 [IPC / HTTP](runtime.zh-CN.md#本地-ipc-与远端-http-api)。自定义 `InvokeTransport` 实现 `id` 和 `invoke(envelope, {signal}?) => Promise<InvocationResult>`；发送到认证后的接收端，由其调用 `runtime.receive(envelope)`。响应必须保留相同 invocationId。Envelope 包含 id/node/target/payload，以及可选 source/execution；target 为完整 WorkerAddress。适配器负责身份认证、序列化、超时和错误映射；receive 本身不是网络服务器。

例如包装应用已有且已认证的 RPC 客户端（不是额外安装 RPC 库）：

```ts
import type { InvocationEnvelope, InvocationResult, InvokeTransport } from "@codesoul-co/ditto/runtime";

export function adaptRpc(request: (
  envelope: InvocationEnvelope, signal?: AbortSignal,
) => Promise<InvocationResult>): InvokeTransport {
  return { id: "application-rpc", invoke: (envelope, options) => request(envelope, options?.signal) };
}
```

随后 `createDitto({ transports: [adaptRpc(request)] })`，使用 `registerRemote({address,capabilities,transportId:"application-rpc"})` 登记已部署的 Worker；request 为应用已连接的客户端函数。完整地址交换和资源清理见 [placement.ts](examples/runtime/placement.ts)。
