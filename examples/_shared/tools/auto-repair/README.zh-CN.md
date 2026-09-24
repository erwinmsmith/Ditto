# 自动修复应用工具

通过公开 `RegisteredTool` 注册到 Interaction Worker。受限编辑语言、真实执行器、验收数据和版本文件属于应用层，不加入 Core。

| 工具             | 参数                     | 行为                                                         |
| ---------------- | ------------------------ | ------------------------------------------------------------ |
| `repair_load`    | `{}`                     | 校验请求、资料、数据库与权限，创建原始版本并返回验收要求     |
| `repair_inspect` | `{revisionId}`           | 读取并核对版本和已有执行回执                                 |
| `repair_run`     | `{revisionId}`           | 重用回执，或实际运行 Node 测试、只读 SQLite 查询、CSV 工作流 |
| `repair_apply`   | `{baseRevisionId,patch}` | 校验失败记录绑定与修改范围，保存不可变新版本                 |
| `repair_publish` | `{report}`               | 复核完整修改/执行链，写入报告与已验证产物                    |

无效提案返回 `INVALID_PATCH`，由 Loop 按预算重试。权限、存储和完整性问题直接失败，工具不允许模型变更测试、资料、路径或权限。业务执行失败仍返回成功的工具调用，其执行结果字段为 failed/blocked，供 Loop 决定是否修复。

代码执行限定在固定包装中的算术表达式；SQL 只支持固定结构的单条 SELECT；配置只能修改固定枚举字段。子进程空环境、超时 10 秒、输出上限 256 KB。代码和配置使用任务副本，SQL 数据库只读；这些边界不构成运行任意第三方程序的沙箱。

`fixtures.ts` 定义可信测试、CSV、固定工作流及要求；`domain.ts` 定义修改范围与数据契约；`adapters.ts` 负责真实执行与文件读写。扩展业务需一起替换执行器、修改策略、验收与幂等约定，不应让模型决定是否跳过验证。

[完整 API 与持久化](../../../../docs/worker-api/auto-repair-workflows.zh-CN.md) · [English](README.md)
