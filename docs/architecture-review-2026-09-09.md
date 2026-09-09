# 2026-09-09 架构理解与差异分析

本次调整将 Ditto 从按一级分类挂载的消息端点骨架，改为 Node-native Runtime 初始化。Node 是语义能力，Worker 是实现和资源边界，Graph 是逻辑执行描述，Runtime 选择实例与通信机制。固定 Contract v1.0 不变。

## 参考依据与优先级

依据是用户本轮明确要求、现有 `13-node-api-contract.md`、两份负责人提供的架构方向文档，以及调整前的源码。Word 文档作为设计资料读取，其示例代码和分包建议没有被视为必须逐字执行的命令。

- `Ditto Overall Architecture and Structure Design (1).docx`：重点参考第 3–10 节语义/执行边界、第 15–20 节能力和 Graph、第 21–29 节通信与 WorkerContext、第 30–38 节扩展与轻量工程。
- `Ditto Node Communication Design (1).docx`：重点参考第 4–8 节 invoke/emit、第 9–14 节 Payload/Envelope/路由、第 17–20 节最小通信组件与非目标。
- `docs/13-node-api-contract.md`：18 个 Node 类型与固定输入输出、空类、版本规则。

参考文件 SHA-256（便于后续辨别文档版本）：

```text
Overall Architecture:
743647AB6EAD137085CCF72C9E8DDFFC06C0DFC3FBE96EA38DF281751C0CF74C

Node Communication:
F7634594F393FBBD250A4192D20A15DC72A422B88237199F0DF049BA09FFECAB
```

两份 Word 原文件未修改，仓库不复制负责人文档全文。下面记录的是结合本阶段范围作出的工程判断。

## 调整前后

| 关注点 | 原初始化实现 | 本次调整及理由 |
|---|---|---|
| 执行边界 | `RegistryMessageNode` 以一级分类为端点 | 独立 `WorkerDefinition` 和注册实例；四个一级名称是命名空间 |
| Node 实现 | 必须先实例化空类并放入 NodeRegistry | `defineNode` / typed handler；`defineWorker` 按全限定名称声明能力 |
| 资源和 Provider | 没有明确的所有者 | 每次注册调用资源工厂；Provider 改变不新增 Node |
| 能力路由 | 同一一级分类全部端点轮询 | 先过滤 Node 能力与可用性，再按位置优先，同层轮询；允许 Worker 部分实现 |
| 位置 | 同进程列表，没有地址概念 | Worker 地址与 Graph 逻辑 ID 分离；直调和适配器路径分开 |
| 通信 | 单一 execute/dispatch 请求响应 | invoke 与 emit 两类语义；EventFabric 独立处理异步订阅 |
| 数据传输 | 请求响应 Envelope 始终存在，无载荷策略 | 本地直调；跨边界 Envelope + Inline/Reference；支持 ArtifactStore/Resolver |
| 组合 | 无 Graph | Runtime 内置最小不可变 DAG 和调度；显式类型化输入映射 |
| 扩展 | Runtime 依赖四类 L1 辅助映射 | 从 NodeContractMap 派生 Node/Worker 类型；实验仓库模块扩展，无需修改路由器 |
| 验证 | 两个类型断言、3 个运行时测试 | 完整 Contract 基准、错误类型拒绝、资源/事件/Graph/位置迁移测试和独立消费验证 |

## 没有机械照搬的设计点

**空类保留为固定 Contract 的兼容入口。** Overall 第 7 节建议删除空类，而固定 API 明确列出它们。本轮优先保持已固定 API，新的执行路径使用声明式定义，不依赖这些类。旧的 NodeRegistry、RegistryMessageNode、InMemoryMessageTransport、NodeRuntime 以及额外 L1 路由辅助类型已移除，避免并存两套运行机制。旧机制签名不提供兼容包装；这是尚未发布的初始化框架调整。

**Worker 使用全限定 Node 名称。** 文档中 `nodes.INFER` 是示意。本实现采用 `nodes["REASONING.INFER"]`，直接复用契约映射，减少隐式字符串拼接和同名 UPDATE 混淆。定义非空 Worker 时验证命名空间与 handler 对应关系。

**扩展通过显式类型映射声明。** 文档展示任意自定义 Input/Output 的 defineNode 示例。本实现让扩展也先进入实验自有的 NodeContractMap 模块声明，再提供 handler，使 invoke、Graph 和 Worker 都有同一份类型来源。TypeScript 合并接口会拒绝给已有节点换一个冲突的类型。

**Graph 需要数据绑定。** 单独 `.edge("select", "infer")` 没有说明 Context 如何变成 InferInput。本实现使用 `.node(id, type, dependencies, bind)`，由 bind 显式生成后续节点输入。运行中的 Graph 不依赖地址，但本阶段不提供可序列化 DSL 或完整 Workflow 产品。

**先做能力感知路由。** 文档允许首版假设同类 Worker 能力相同，但同时允许部分实现。直接保留原轮询会导致“已注册节点仍随机报未实现”。因此本轮将能力过滤作为最低正确性要求加入，实现仍保持小型内存注册表。

**两类通信与扩展端口，按实际需要加载重能力。** Runtime 不因文档列出 RPC、NATS、MCP 或模型而安装相应 SDK。invoke 的地址路由、关联 ID 与适配器入口可运行；emit 默认本地异步分发，可替换 Fabric。真实 IPC/RPC/PubSub 是后续适配器。

**轻量与能力完整性分别约束设计。** MetaGPT 被理解为可组合 Agent 能力的参考方向；PI-agent 被理解为用户明确要求的轻量 Core 取向。本轮没有声称与这两个外部项目实现级兼容，也没有引入其业务流程或依赖。

## 本轮实现范围

完成声明式 Node/Worker、资源工厂与配置、注册/移除/可用性切换、能力和位置路由、同级副本轮询、DAG 依赖调度、invoke、异步 emit、可替换 EventFabric、ArtifactStore、Inline/Reference 编解码、适配器接收入口和实验仓库调用。

Graph 从直接调用切换到序列化适配器时无需改定义。测试以两个 Runtime 对象模拟通信边界，验证信封、逻辑 Graph 标识与输入输出隔离；没有将这一验证描述为真实多设备部署完成。

本阶段仍不实现模型/数据库/工具业务、生产 RPC/IPC/NATS、自动扩容控制器、负载/队列调度、分布式状态、重试/超时/故障恢复、流式协议、资源生命周期管理、运行中 Graph 迁移或 npm 发布。对这些能力的需求应通过既有扩展边界演进，而非新增 Node API 字段。

## 验证与迁移

`npm run check` 会检查所有类型、运行测试并干净构建。`test/reference-contract.ts` 来自固定文档的全部 TypeScript 段落，测试保证基准与文档一致，类型检查比较内置 18 个 Contract 的完整输入输出结构。实验扩展节点不混入内置规范。

`examples/experimental-consumer` 有独立 package.json/tsconfig，使用 `file:../..` 依赖。它校验生成的公开声明、运行跨能力 Graph、注册额外副本，并通过公开模块扩展自定义 Worker，证明消费端不必依赖源码别名。

后续实验代码从 `NodeRuntime.mount/execute` 改为 `createDitto/register/invoke/run`；业务实现可以转为 defineWorker handler，也可以通过固定空类实例的 execute 做轻量适配。详细边界及使用注意事项见 [architecture.md](architecture.md)。
