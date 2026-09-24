# 订单履约工具

[Plan-and-Execute 示例](../../../patterns/plan-and-execute/README.zh-CN.md)的应用层 `RegisteredTool` 适配器，使用公开 Interaction Worker、文件系统和 Node SQLite，业务依赖不进入 Core。

`createDemo` 初始化隔离订单、库存、运价及权限文件；`PlanAdapters` 注册库存预留、打包、订运、回执，以及仅控制器使用的权限核对、快照、结果核验和发布工具。模块导入不执行任务；`close()` 释放业务数据库，应用另行关闭 Redis/Memory。

本地业务边界是 `business.sqlite`，包含真实事务变更，不向生产承运商订运。接入 ERP/承运商时替换工具适配器，保留身份范围、实时前置条件、整数金额、稳定幂等键和已提交结果核对。第三方 SDK 留在应用配置目录，不进入 Core，不在 Loop 生成器中直接执行工具。

可信控制器创建请求和权限。动作参数只能包含固定订单 ID；模型只能从封闭工具列表规划。证据以 SHA-256 内容寻址并不可变保存；每个目录只运行一个活动执行者。限制、恢复、数据库职责及生产接入责任见[完整契约](../../../../docs/worker-api/plan-execute-workflows.zh-CN.md)。
