# ReAct 应用工具

[English](README.md) · [完整示例](../../../patterns/react/README.zh-CN.md)

`domain.ts` 定义可信任务、模型动作校验、CSV 算术与报告契约。`adapters.ts` 注册任务查询、日志、手册检索、恢复及 API/浏览器结果工具。`service.ts` 提供真实、可重启的本地 HTTP/SQLite 任务服务。这些业务实现属于应用，不进入 Core。

`createTask` 固定请求和权限指纹，`ReactAdapters.tools` 通过公开 Interaction Worker 注册。模型只获得业务工具目录；`react_authorize`、`react_verify`、`react_publish` 由控制器调用。模型动作使用 SAMPLE 原生工具协议，整个批次先校验作用范围再执行。

业务服务使用 `service.sqlite`；Agent 使用 [存储适配器](../storage/README.zh-CN.md) 提供的 Redis Context 与独立 SQLite Memory。手册检索读取真实文档。浏览器工具复用 [operations/sdk.ts](../operations/sdk.ts) 的 Playwright 配置；API 路径不需要安装浏览器，浏览器路径需先安装 Chromium。

恢复必须有对应日志和手册依据，只允许当前任务的瞬时故障。每次 POST 前核对任务幂等键，服务端以事务保存实际效果和回执。响应不确定时返回 Observation，由 Agent 再查询；不能把丢失响应当成没有发生副作用。演示 HTTP 超时为 400 毫秒，用于可重复的延迟响应实验；外部服务适配器应按实际延迟配置。

证据按内容哈希保存。完成前重新查询业务状态、CSV 并核对整数算术，生成验证凭据；发布时核对凭据和每个成功 Observation 的证据快照，再幂等写入 Markdown/JSON。发布不会暗中恢复远端任务，也不会发送消息。

宿主负责真实身份认证、来源授权和单任务互斥。本地服务是运行参考，不是生产身份系统。外部服务需要对应的认证、权限、取消与副作用核对实现。完整调用见 [ReAct API](../../../../docs/worker-api/react-workflows.zh-CN.md)。
