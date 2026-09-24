# 深度研究工具

[English](README.md) · [完整示例](../../../patterns/deep-research/README.zh-CN.md)

`domain.ts` 定义可信研究请求、子问题计划、逐轮覆盖、预算和报告校验。`adapters.ts` 是应用侧工具接线，复用 `WebAdapters` 的真实搜索、HTML 阅读、快照与引用检查，提供研究授权及 Markdown/JSON 交付；不增加 Core 的第三方依赖。

`createTask` 创建不可变请求和权限绑定；`ResearchAdapters.tools` 注册 `web_search`、`web_read`、`web_check`、`research_authorize`、`research_publish`。所有操作由公开 Interaction Worker 派发。研究权限在每次访问时和网页权限一起检查。模型不能修改可信请求、提高预算或扩大来源白名单。

环境配置沿用 [网页工具](../web-search/README.zh-CN.md) 与 [存储工具](../storage/README.zh-CN.md)。测试专用 loopback 和网络代理开关不应被当作生产网络策略。调用方负责用户身份认证、目录隔离和单任务互斥。

发布先核对报告契约和每条引用对应的原始快照，再幂等写入 `output/report.md`、`output/report.json`。实际恢复进度保存在数据库 Memory，不能用工具缓存替代。完整 API、预算和来源边界见 [研究工作流](../../../../docs/worker-api/research-workflows.zh-CN.md)。
