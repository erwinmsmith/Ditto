# 客户与订单工具适配器

供[工具链执行](../../../patterns/tool-chain/README.zh-CN.md)使用的应用侧 `RegisteredTool`。`domain.ts` 校验对象范围、版本、模型判断和规范化参数；`adapters.ts` 注册授权查询、证据验证、CRM 写入、通知、结果核验和发布；`service.ts` 提供真实 HTTP 服务，使用独立 SQLite 业务数据库、原子操作回执和持久测试收件箱。

工具包括 `chain_authorize`、`chain_customer`、`chain_orders`、`chain_payment`、`chain_shipment`、`chain_validate_reads`、`chain_crm`、`chain_notify`、`chain_verify`、`chain_publish`，统一通过 `INTERACTION.ACT.TOOL` 执行，副作用结果通过 `INTERACTION.OBSERVE` 观察。外部写入重试前先核对回执。完整契约与生产服务替换要求见 [API 文档](../../../../docs/worker-api/tool-chain-workflows.zh-CN.md)。

`createDemo(directory,scenario,overrides)` 创建隔离测试服务与请求，`createTask` 保存不可变请求和策略，`resumeDemo` 在原地址恢复服务。使用后关闭服务和 Runtime/storage。测试服务不是生产认证边界。本地场景使用 Node HTTP/SQLite，无需第三方业务 SDK；Redis 依赖沿用 [storage](../storage/README.zh-CN.md)。业务工具不进入 Core。
