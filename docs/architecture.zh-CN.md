# Ditto 架构

[English](architecture.md) · **简体中文**

Ditto 保持一个 TypeScript package，Core 没有第三方运行时依赖。Worker 是部署、资源和扩容单位，Node 是 Worker 内部的能力单元，Graph 描述 Node 之间的依赖与数据转换；Runtime 提供执行、路由、通信及运行服务。

## 结构与职责

```mermaid
flowchart TB
  App[应用配置 / 入口 Graph] --> Runtime[Runtime：配置、调度、路由、通信]
  Runtime --> A
  Runtime --> Transport[HTTP / 自定义 IPC 或 RPC]
  Transport --> B[另一 Runtime 的 Worker]
  subgraph A[Worker 副本：资源、并发上限、生命周期]
    Entry[公开入口 Node] --> G[内部 Graph]
    G --> Think[模型 Node]
    G --> Tool[工具 / MCP Node]
    G --> Skill[Skill Node]
  end
  Think --> Services[Runtime Services：Provider / Sandbox / Config]
  Tool --> Services
  Skill --> Services
```

| 模块 | 职责 |
| --- | --- |
| `contracts/` | 仅共享 Message/Reference/JSON、通用 NodeContractMap 接口与类型导出 |
| `worker/node.ts`、`worker/execution-context.ts` | 共享 typed handler、`defineNode` 与执行上下文，不放领域操作 |
| `worker/define-worker.ts` | `defineWorker` / `extendWorker`、公开能力与副本资源 |
| `worker/memory/` | `contracts.ts`：Memory 实体与 RETRIEVE / WRITE / UPDATE / CONSOLIDATE / EVICT 契约 |
| `worker/context/` | `contracts.ts`：Context 实体与 LOAD / SELECT / UPDATE / COMPRESS / RESET 契约 |
| `worker/reasoning/` | `contracts.ts`：推理契约；`generate.ts`：模型生成；`providers/`：模型适配器 |
| `worker/interaction/` | `contracts.ts`：交互契约；`loop.ts`：交互循环及 handler 组合；tools / MCP / Skills |
| `runtime/` | Graph 构建与执行、实例注册与路由、invoke / emit、HTTP、Artifact、配置与服务装配 |
| `runtime/communication/` | InvokeTransport、HTTP、异步事件；调用与事件语义分离 |
| `runtime/sandbox/` | 权限检查、工作区文件操作、隔离执行器接口 |

Node 是对执行操作的抽象表示，不是每个 Worker 都需要建立的物理模块层。记忆检索直接属于 memory，模型生成直接属于 reasoning，交互循环直接属于 interaction；不再设置 `worker/<capability>/node/`，也没有独立 agent/ 目录。共享的类型化 Node 定义留在 `worker/node.ts`，18 个原有语义契约直接收在各能力模块的 `contracts.ts`；各 Worker 在自己的 `contracts.ts` 中扩展 `NodeContractMap`，中央只保留通用接口。`createInteractionNodes` 返回的是 handler 映射，并不创建独立 Node 子系统。Graph 构建与调度同在 `runtime/graph.ts`，实例注册与生命周期同在 `runtime/runtime.ts`，不为目录对称增加空管理器。

Memory 与 Context 这次初始化到契约层，具体存储、检索、选择、压缩策略由应用实现；不会用假实现冒充完整后端。Reasoning 已有可替换模型适配器和生成 Node；Interaction 保留可运行的工具循环。模型生成实现属于 reasoning，`createInteractionNodes` 显式组合它，避免重复实现。

## contracts 放什么

`contracts/` 是类型协议，不是独立业务层，也没有执行器、存储或模型逻辑：

- `common.ts`：跨 Worker 共享的 Message、Reference 和 JSON 数据类型。
- `node-contract-map.ts`：通用 NodeContract<Input, Output>、开放的 NodeContractMap 接口，以及 InputOf / OutputOf 类型推导。
- `index.ts`：仅用 type 导出，作为 npm 包的统一类型入口；包含各 Worker 的契约声明。

具体类型和 Node 名称的映射一起归属对应 Worker。例如 MemoryItem、MemoryRetrieveInput 和 MEMORY.RETRIEVE 的声明都在 `worker/memory/contracts.ts`。增加 Memory 的操作时，在 Memory 内补充契约及 handler；不需要修改 Runtime 或中央操作枚举。这些 TypeScript 类型在编译后擦除，不参与运行路由，也不提供网络输入校验。

Node 是 Worker 内的操作。例如真实记忆检索实现应放 `worker/memory/retrieve.ts`，其 handler 挂到 Memory Worker 的 nodes 中；只有实现确实需要时才建文件。`worker/node.ts` 只共享 handler/defineNode 的类型和定义工具，不拥有 Memory 的能力。目前 Memory / Context 初始化到契约，尚未提供数据库、检索、压缩实现。

## Worker 是 Node 的容器

内置能力按 `MEMORY`、`CONTEXT`、`REASONING`、`INTERACTION` 组织，推荐同名 Worker 作为部署边界。这些名称不是一级 Node。自定义 Worker.type 仍可为任意字符串；保留显式组合不同领域 Node 的能力，例如 Interaction Worker 组合 reasoning 的 GENERATE，不将目录归属误当作运行位置限制。

`defineWorker({ nodes, expose })` 中，`nodes` 是内部实现集合；`expose` 是参与 Runtime 路由、允许远端调用的入口集合。省略 `expose` 时，为兼容旧代码公开所有已实现 Node。推荐 Agent Worker 只公开 `INTERACTION.RUN`，内部的模型、工具、Skill Node 通过内部 Graph 使用。

每次 `register(definition)` 都创建一个副本，并执行一次 `resources()`。资源可存放副本私有缓存、连接或业务状态；`config` 是同一 Worker 定义共享的只读业务配置。模型、Key、权限等基础配置来自执行端的 `ctx.services`，不进入 Node 业务输入。

在多副本之间需要共享的数据，应放在显式共享存储中。定义闭包中的对象也会被各副本共享；如 `ToolRegistry` 中存在可变执行状态，应改用 `ctx.resources` 或单独定义 Worker。异步连接可以先建立，或将资源中的 Promise 交给 handler 等待；关闭资源使用 `dispose(resources)`。

## 两种 Graph 范围

| 入口 | 选择与执行行为 | 用途 |
| --- | --- | --- |
| `runtime.run(graph, input)` | 每个任务按公开 Node 能力选择 Worker；可跨副本、跨服务器 | Worker 之间的应用编排 |
| `ctx.run(graph, input)` | 全部任务固定在当前 Worker 副本；可使用未公开 Node | Worker 内部子结构 |
| `ctx.invoke(node, input)` | 按公开能力重新路由，可调用其他 Worker | 明确的跨 Worker 请求 |

内部 Graph 在执行前验证当前 Worker 实现了全部任务。不会因为缺少内部 Node 而偷偷转发到别的副本。因此同一次内部 Graph 能共享该副本的资源与配置。`ctx.invoke` 不保证留在当前副本，需要内部调用时使用 `ctx.run`。

Graph 是不可变 DAG。`node(id, nodeType, dependencies, bind)` 定义任务、依赖和输入映射；相同语义 Node 可以多次出现，只需不同逻辑 ID。依赖只能引用此前声明的任务；独立分支并发，失败任务的下游不运行，调度器等待已启动分支收尾再返回。执行不会回滚已完成的外部副作用。

Graph 中没有 Provider Key、物理地址或副本数量；`bind` 是 TypeScript 函数，Graph 本身不可直接 JSON 序列化。传输的是公开 Node 调用，远端 Worker 执行已部署的内部 Graph。有限 Agent 循环由 `INTERACTION.RUN` 实现，每轮使用内部 Graph；没有将有环工作流或持久化调度引入 DAG 核心。

## 扩容与生命周期

手动重复 `register(worker)` 增加本进程副本；另一服务器部署相同定义后，通过 `registerRemote` 增加远端容量。Node 契约与 Graph 不需要改动。同进程副本共享事件循环，不能增加 CPU 核数；CPU 工作需要部署到其他进程或机器。

路由先过滤公开能力、可用性与本地并发容量，再按同进程 → 同 host → 跨 host 排序，同级轮询。本地副本满载时可使用其他副本。`concurrency` 限制每个副本的入口调用数，默认无限制；内部 Graph 在一个已接受的入口调用内执行，不再次申请该配额，避免并发为 1 时的嵌套死锁。内部 Graph 的分支数仍由应用控制。

`workers()` 可查看地址、公开能力、可用性和本地观察到的 active/concurrency。远端容量由接收端限制，调用端没有实时远端负载视图。全部候选不可用时立即失败，没有无界等待队列、自动重试或自动扩机器。

- `setAvailable(false)`：暂停接收新的路由。
- `unregister()`：仅移除路由，不中断已接受调用；资源继续保留，之后调用 handle/runtime 的 `close()` 回收。
- `await handle.close()`：停止路由，等待本副本已接受的调用，释放资源一次。
- `await runtime.close()`：拒绝新调用并关闭所持有的 Worker；释放失败以 AggregateError 返回。

Handler 必须 await 自己启动的工作。关闭 Runtime 时未开始的 Graph 下游或新的跨 Worker 请求可能被拒绝，因此应用应先停止接收请求、等待顶层任务，再关闭 Runtime。调用自身 handle.close 并等待会等待自己，不应在本 Worker handler 内这样做。EventFabric、外部 Provider/MCP 客户端与 HTTP Server 的生命周期由应用所有者管理。

## 契约与扩展

既有 `NodeContractMap` 的 18 个输入输出契约及 Message/Reference 保持 v1.0。`INTERACTION.RUN/TOOL/SKILL` 在 interaction 声明扩展，`REASONING.GENERATE` 在 reasoning 声明扩展，不再使用 AGENT 命名空间。自定义能力通过相同声明合并机制扩展，无需修改 Router/Scheduler 枚举。`defineWorker<R, C>` 使用全名键（如 MEMORY.RETRIEVE），`extendWorker("MEMORY", { nodes: { RETRIEVE: ... } })` 使用短操作名；后者返回新定义，不修改已注册实例，也不隐式继承未提供的 handler。

资源继续使用 `resources: () => ({ ... })`，保证每次注册创建自己的资源。相较草案中的资源对象写法，这里明确保留工厂语义，避免副本意外共享可变状态。Graph 继续用 `.node(id, type, dependencies, bind)` 明确输入映射，避免把检索结果未经转换传给要求 messages 的推理 Node。

运行设置和业务输入分离：`ctx.services.config` 提供环境、默认模型和超时，`ctx.services.providers` 选择适配器，`ctx.services.sandbox` 检查能力。Runtime 不运行 Agent 循环，不扫描 Skill，不建立 MCP 连接；这些行为由 Agent Node 和应用启动代码控制。

通信细节见 [Worker 通信](worker-communication.zh-CN.md)，Agent 配置与安全边界见 [Agent 与运行配置](interaction-runtime.zh-CN.md)。

## 执行路径的轻量约束

同进程调用沿 Runtime → Worker handler 执行，不经过基类或适配层；只有跨进程调用才编码 payload。Worker 中的 handler 在定义时建立查找表，Graph 是不可变计划，运行只创建自己的结果与依赖等待。Agent 的三个内部计划预先构建并跨轮次/副本复用，避免每个工具调用都重新构图。

Router 用一次遍历筛选能力、容量与位置，保留同级轮询；没有维护第二套复杂索引或调度服务。需要扩展时增加具体 Node 或适配器，不以每个概念拆一套 class/factory/registry。性能变化未作吞吐基准承诺，当前验证保持调用、并发与路由语义一致。
