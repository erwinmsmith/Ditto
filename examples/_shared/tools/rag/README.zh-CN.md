# RAG 应用工具

[English](README.md) · [完整流程](../../../patterns/rag-qa/README.zh-CN.md)

`RagAdapters` 通过公开 `RegisteredTool` 和 `RetrievalTargetRegistry` 注册授权检查、资料接入、FTS5 检索、快照校验及文件发布。Core 不包含这些业务规则或 SQLite 表。仅依赖 Node.js 标准库；Redis 连接复用相邻 `storage/` 的应用依赖。

`domain.ts` 定义规范化请求、可信来源目录、中文检索词、文本块、筛选结果及逐条引用约束。`adapters.ts` 分别读取用户文件、独立业务数据库和控制器提供的获准 Memory 记录。所有工具由 Runtime 经 `INTERACTION.ACT.TOOL` 调用；FTS Provider 经 `RETRIEVAL.SEARCH` 调用。

目录中的身份、来源读者列表和连接由可信宿主配置，不交给模型决定。一个适配器绑定一个请求及任务目录，宿主负责并发互斥和文件访问权限。
