# 分析报告与核验工具

应用层 `RegisteredTool` 适配器，用于 [Reflection 示例](../../../patterns/reflection/README.zh-CN.md)。`createDemo` 建立真实 CSV、可选初稿和权限文件；`ReflectionAdapters` 注册加载、草稿保存、确定性核对、审阅保存和发布工具。导入模块不执行任务。

来源与请求绑定哈希。净收入按收入减退款计算，增长率保留两位小数；引用必须逐字匹配 CSV 行。不可变草稿、检查证据和审阅记录组成审计链。模型评价负责解释是否有依据及建议是否有用，不能覆盖确定性错误。

接入其他内容、报告或代码任务时，在本层替换草稿契约、资料加载器和核验器；不要向 Core 添加业务依赖，也不要在 Loop 中直接执行工具。可信应用保护目录并注入身份。见[完整契约](../../../../docs/worker-api/reflection-workflows.zh-CN.md)。
