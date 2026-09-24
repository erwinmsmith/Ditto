# 多 Agent 应用工具

`domain.ts` 定义限定 Agent 注册表、计划/依赖校验、角色资料、专职结果和汇总覆盖规则；`adapters.ts` 提供真实资料读取、不可变结果保存、摘要校验交接和 Markdown/JSON 报告交付，供[多 Agent 分工](../../../patterns/multi-agent/README.zh-CN.md)使用。

工具包括 `team_authorize`、`team_read_engineering`、`team_read_operations`、`team_save`、`team_result`、`team_publish`，全部通过公开 Interaction 节点执行。角色读取工具固定资料范围并拒绝额外参数，规划 Agent 不能创建新工具、选择任意路径或修改注册表。业务逻辑不进入 Core。

`createDemo(directory,overrides,ready)` 初始化独立资料、请求和策略；`TeamAdapters(directory,request)` 不创建后台连接。Runtime 沿用 Redis/SQLite [存储适配器](../storage/README.zh-CN.md)。保护任务目录，本地策略不能代替生产认证。范围、重试和预算详见 [API 文档](../../../../docs/worker-api/multi-agent-workflows.zh-CN.md)。
