# 扩展 Worker 与 Node

优先判断扩展落在哪一层：新的 API/系统操作通常是 Tool；新的模型协议是 ModelProvider；新的存储是 MemoryStore；新的检索算法是 SearchProvider。只有出现可独立路由的新语义操作时，再扩展 Node 契约与 Worker。

## 1. 选择扩展点

| 需求 | 推荐接口 | 是否新增 Node |
| --- | --- | --- |
| 查询 CRM、执行浏览器动作 | RegisteredTool / McpClient | 通常不需要 |
| 替换数据库或搜索算法 | MemoryStore / MemorySearchProvider | 不需要 |
| 增加模型供应商 | ModelProvider | 不需要 |
| 自定义上下文选择/压缩 | ContextServices | 不需要 |
| 新的业务语义、独立部署资源边界 | NodeContractMap + defineWorker | 可以 |
| 为现有 namespace 增加操作 | 契约扩展 + 新 Worker definition | 可以，不能直接修改已注册对象 |

## 2. 一份可运行的完整实现

```sh
node examples/handbook/extensions.ts '  Café 😀  '
```

预期返回规范化文本 `Café 😀`、按 Unicode code point 统计的长度，以及当前 Worker 副本的调用计数。

<<< ../../examples/handbook/extensions.ts

这个例子有两个语义节点，都属于 `text` Worker：NORMALIZE 是私有实现，ANALYZE 是公开入口。Runtime 从外部只能路由 ANALYZE；内部 handler 通过 `ctx.run` 使用同一副本的 NORMALIZE。

## 3. 声明契约

`declare module "@codesoul-co/ditto/contracts"` 扩展开放接口 `NodeContractMap`。键为完整语义叶子，值为 `NodeContract<Input,Output>`。导入此模块后，graph.node/runtime.invoke 能推导输入输出类型。

类型声明不会注册 handler，也不会校验来自网络的 JSON。执行时仍要验证输入的类型、长度、枚举、资源归属及业务权限。避免使用任意 `as any` 绕过节点契约。

如果扩展单独发布 npm 包，确保生成的 `.d.ts` 包含 module augmentation，并从包入口引入该声明；主包作为兼容版本的 peer dependency。消费者需要导入扩展包后再使用新增 Node。

## 4. 定义 handler 和资源

`defineNode(workerType,nodeType,handler)` 固定归属、类型和执行函数。`defineWorker({type,nodes,resources,config,dispose})` 组合节点并定义副本资源。

- `resources()` 在每次本地注册时调用一次，适合创建该副本专属连接或计数器。它是同步工厂；异步连接可提前准备，或以 Promise 放在 resources 中并由 handler 等待。
- `config` 保存不变业务配置，不放请求级状态。
- `dispose(resources)` 关闭该副本拥有的资源；共享客户端由外层应用统一管理。
- `expose` 限定公开节点；省略时全部公开。
- `concurrency` 限制副本入口并发，不代表业务事务串行或持久队列。

Node 的命名空间和 Worker 的部署名称可以不同。定义对象不可变，不要通过访问私有字段或 `.instantiate()` 自行调用 executor 来绕过 Runtime。

## 5. 在已有 Worker 中扩展 Node

内置 Worker 的 definition 不暴露可随意修改的 nodes 集合。新增操作时可以构造新的 definition，或用公开 node descriptor/handler factory 组合既有能力。

例如 Interaction 的 `createInteractionNodes` 返回可复用的 WorkerNodes；在新的 INTERACTION definition 中可以保留这些节点并增加自定义叶子。新增叶子仍先扩展 NodeContractMap，再提供 handler；ToolRegistry/McpRegistry 是显式对象，不是工具数组。

```ts
// 接线结构：customNode 已通过 NodeContractMap 声明并实现。
const worker = defineWorker({
  type: "INTERACTION",
  nodes: {
    ...createInteractionNodes({ tools: toolRegistry, mcp: mcpRegistry, output: sink }),
    "APP.AUDIT.RECORD": customNode,
  },
});
```

此处 `customNode` 若使用 defineNode 创建，workerType 必须是 INTERACTION。省略 expose 时两部分均公开。需要副本独立 registry 时在定义设计中明确资源归属，不要误把共享 registry 当独立副本。

`extendWorker("APP.TEXT",{nodes:{NORMALIZE:handler}})` 是相对名称的构造简写；它创建新的 Worker definition，并不修改之前的对象或热更新在途请求。细节见[组合 API](../worker-api/composition.zh-CN.md)。

## 6. WorkerContext 能做什么

| 字段/方法 | 使用方式 |
| --- | --- |
| resources / config | 当前副本资源与定义配置 |
| services | Runtime 的 config/providers/sandbox |
| signal | 传给 SDK/数据库/文件读取，实现合作式取消 |
| run | 同一副本内部 Graph，可访问私有节点 |
| invoke | 按公开能力路由到其他 Worker |
| emit | 发布事件；接受事件不等于消费者执行完毕 |
| artifacts | 可选大对象存储，需 Runtime 显式配置 |
| execution / worker | 运行与节点 scope、Worker 地址 |

handler 必须 await 自己发起的工作，不要留下脱离取消与生命周期的后台任务；也不要在 handler 内等待自身 Worker 的 close，造成循环等待。

## 7. 注册、替换和远端部署

`runtime.register(definition,{id})` 得到 handle。可用性切换阻止后续路由，但不自动撤销已运行任务。`unregister` 移除路由，`close` 负责资源释放，两者含义不同。

部署新实现时先注册新副本、完成健康检查，再停止旧副本的新请求并等待排空。远端 Worker 通过 registerRemote 和通信适配器接入；传输双方共享节点契约与版本，业务 Graph 不写死主机地址。

## 8. 扩展包验收

验证合法/非法输入、输出形状、资源创建与释放、两个副本互不串状态、私有节点不可外部调用、取消和并发限制。再在仓库外安装真实 tarball，以无 paths 别名的 TypeScript 配置验证契约扩展与实际执行。

[完整组合 API 与例子](../worker-api/composition.zh-CN.md) · [部署](deployment.md) · [检索包作为扩展实例](retrieval.md)
