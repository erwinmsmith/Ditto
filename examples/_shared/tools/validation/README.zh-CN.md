# 验证与安全工具

`domain.ts` 定义固定输入结构、敏感识别/脱敏、结果要求、指标冲突、评估引用、权限及风险规则。`tools.ts` 提供 `validation_source`、`validation_commit` 两个 RegisteredTool 和可信控制器方法。`fixtures.ts` 生成合成发布材料和独立业务数据库，不连接外部用户或真实发布平台。

原始文件只在适配器内读取和脱敏；工具返回可安全进入 Context、Memory 和模型的结构。发布工具复核源数据和评估，在业务 SQLite 写事务内读取策略、校验批准和写入实际发布记录，然后生成带摘要的报告。重试使用幂等记录核对已完成副作用。

工具不依赖模型厂商 SDK，也不扩充 Core 的数据库依赖。真实 Redis、SQLite Memory 的生命周期复用相邻 `storage/`；原子不可变文件交付复用 `execution/files.ts`。生产应用可替换敏感检测器、认证/授权服务及业务存储，保持门禁与写操作在同一服务端边界。

完整参数、检测限制和调用方法见 [API 文档](../../../../docs/worker-api/validation-workflows.zh-CN.md)。不要把 `requiresApproval` 元数据当成 Core 自动审批，也不要把示例控制器的身份字符串当成认证凭据。
