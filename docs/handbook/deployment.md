# 部署、资源与生命周期

先在单进程中验证完整应用，再根据资源、隔离或扩容需求拆分 Worker。Graph 保持语义节点与依赖；连接地址、Worker 副本和凭据由运行环境配置。

## 1. 单进程基线

| 资源 | 创建时机 | 关闭方 |
| --- | --- | --- |
| Redis / SQL / 向量客户端 | 应用启动，或可信会话资源管理器 | 应用 |
| Worker 副本专属资源 | definition.resources() | definition.dispose |
| MCP Client / Transport | 应用启动并连接 | 应用，Runtime 排空后 |
| Runtime | 资源就绪后创建、注册 Worker | 应用 |
| 请求上下文 | 每次请求，指定可信 scope | TTL / 任务清理策略 |

不要每个 Node 都重新建连接池，也不要每个请求关闭共享 SDK。进程收到停止信号时先停止接新任务，取消或等待在途任务，持久化必要状态，再释放资源。

## 2. 并发是分层的

Graph concurrency 控制当前图的就绪节点数；Worker concurrency 控制一个副本的入口执行；业务对象的串行化与数据库事务另行实现。多个会话可并行，同一会话写 Memory/Context 要有明确冲突处理。

路由不到可用 Worker 会报错，不代表 Runtime 有无限持久队列。需要任务队列时由应用接入，并设置容量、超时和重复投递策略。

## 3. IPC 与 HTTP

Runtime 提供本地、IPC 与 HTTP 通信入口。通信适配器携带节点、目标地址、payload 与执行 scope；接收端使用相同契约处理。完整 API 与可运行地址交换示例见 [Runtime 部署章节](../worker-api/runtime.zh-CN.md#本地-ipc-与远端-http-api)与 [placement.ts](../worker-api/examples/runtime/placement.ts)。

HTTP 接口需要认证、访问控制、TLS 与网络边界；不要把无认证的 receive 暴露到公网。跨机器的 localhost、工作目录和内存对象不会自动共享。取消能力也取决于传输与目标 SDK 的实际支持。

## 4. 事件与大对象

`emit` 表示事件已被接受，不表示消费完成。LocalEventFabric 是进程内广播，不是跨机消息队列；需要持久化和重投递时实现自己的 EventFabric，并使用业务幂等键。

ArtifactStore 可将大 payload 转为引用。跨进程双方必须访问相同的外部对象存储，并约定权限、有效期和清理。默认 InMemoryArtifactStore 只存在当前进程，也不自动成为 Context ReferenceResolver。

[组合、事件与 Artifact API](../worker-api/composition.zh-CN.md)给出接口与完整示例。

## 5. Sandbox 与容器

Sandbox 检查工具名、MCP server、skill、网络 origin 和文件操作。它不是执行任意不可信 JavaScript 的隔离容器。第三方 SDK 和自定义 handler 必须合作执行权限策略；代码执行任务优先用受限容器、低权限用户、资源上限及独立工作目录。

Graph 输入不携带密钥；错误与日志使用稳定错误码，保留内部诊断到受控日志。不同租户的凭据、工作目录、Memory namespace 和索引过滤应由可信控制器选择。

## 6. 监控与升级

按 taskId、turn、graphId、nodeId、invocationId 关联日志。记录耗时、状态、预算消耗和工具回执；对敏感输入先脱敏。模型输出、Context 和 Memory 不能默认全量记录。

升级 Worker 时维持契约兼容；持久 checkpoint 带 schemaVersion；对数据库执行可恢复迁移；新增检索索引先验证再切换。为外部依赖不可用、结果不确定和人工等待设置明确状态，不返回含糊的成功。

## 7. 发布包与部署应用的区别

发布 Ditto npm 包提供框架和声明，不部署你的 Redis、数据库、模型或工具服务。部署 Agent 应用时锁定依赖版本、安装对应 SDK、注入运行配置、执行环境验收，再启用真实业务入口。

[长任务部署示例](../../examples/patterns/long-running/README.zh-CN.md) · [配置总表](../worker-api/configuration.zh-CN.md) · [错误与恢复](reliability.md)
