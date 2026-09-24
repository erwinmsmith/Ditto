# 执行结果工具与参考服务

[English](README.md) · [应用工具](../README.zh-CN.md) · [五项流程](../../../capabilities/observation/README.zh-CN.md)

本目录使用 Node.js 24 的 HTTP、SQLite 和文件 API，提供应用侧结果读取、状态更新及后续动作工具。无新增第三方 SDK；Redis 与 Memory 复用 [存储适配器](../storage/README.zh-CN.md)。通过 `createInteractionWorker({ tools: adapters.tools })` 注册，由 Runtime Graph 执行。

| 文件 | 职责 |
| --- | --- |
| [domain.ts](domain.ts) | 请求验证、严格 CSV/结构化结果校验、错误分类与动作预算、Observation 字段完整性验证 |
| [tools.ts](tools.ts) | `ResultTools`：HTTP 结果工具、事务性任务状态、不可变产物发布 |
| [service.ts](service.ts) | 真实 HTTP 参考服务、独立 SQLite 业务状态、数据初始化及重启 |

## 工具

`result_read` 请求结果；`result_retry` 执行一次幂等 POST；`result_status` 查询实际业务状态。这三个工具返回公开 `ExternalResult`，保留 JSON/CSV 原始内容、结构化字段、引用与 HTTP 元数据。HTTP 403/404/503、服务明确取消、客户端超时和连接断开被映射为相应结构化结果。未知程序异常仍抛出，不伪装为正常业务错误。

HTTP 地址由控制器配置，模型不提供 URL。请求验证工具许可及网络 origin，拒绝重定向，限制响应为 16 KiB。本示例的结果读取截止时间为 150 毫秒；参考服务的超时场景延迟 600 毫秒并提前保存真实业务状态，用于验证“未收到响应不等于业务失败”。生产适配器应按目标系统延迟设置截止时间。

`result_commit` 接收已校验解释和原结果，重新核验证据后，事务更新 `tasks.sqlite`。同一轮内容一致的重放保持版本不变，冲突或过期版本失败。后续工具必须与任务库中的 `waiting_retry` / `reconciling` 状态匹配。

`result_publish` 仅发布与终态一致的报告，保存为 `artifacts/result.json`；已存在相同内容可重放，不同内容会失败。它不发送消息，也不触发人工分派服务。

## 系统边界

`memory.sqlite` 由公开 Memory Worker 管理；`tasks.sqlite` 是应用状态库；`remote.sqlite` 是 HTTP 服务的业务库。三者各自持久化，不相互替代。

参考服务的重试使用任务 ID 派生的幂等键，原子地将重试次数从 0 更新到 1。传输超时、连接断开和调用者取消都不表示回滚；调用者取消直接传播，远端不确定结果则经模型解释和验证后核对。

CSV 工具采用固定列 `orderId,quantity,unitCents,status`，是此业务协议的解析器，不是通用 CSV 导入器。成功结果还要验证订单归属、正整数数量/单价及安全整数金额。模型解释中的调用 ID、金额、错误分类和动作必须与原结果一致；工具文本不能作为授权来源。

每个任务使用独立目录。调用结束后关闭 Runtime、ResultTools、Memory/Redis 和 HTTP 服务。导入模块不会打开数据库、启动服务或调用模型。测试报告和生成文件由仓库忽略规则排除。
