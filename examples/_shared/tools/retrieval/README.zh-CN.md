# 检索工具与第三方配置

[English](README.md) · [八项检索示例](../../../capabilities/retrieval/README.zh-CN.md)

该目录属于应用层，不是 `@codesoul-co/ditto` 的内部实现。安装独立 HTML 解析器依赖：

```sh
npm ci --prefix examples/_shared/tools/retrieval/dependencies
```

- `memory.ts`：经 `MEMORY.WRITE` 显式导入内部长期知识；不导入任务归档。
- `domain.ts`：请求、查询、证据、引用与报告契约。
- `adapters.ts`：文档检索 Provider、SQLite FTS5 Provider、页面读取和本地报告工具。
- `web.ts`：Wikipedia 搜索 Provider、HTTPS 传输和 LinkeDOM 正文解析。HTML 作为数据解析，不运行脚本。
- `dependencies/`：应用 SDK 配置和锁文件。消费者也可将 `linkedom` 安装到自己的项目根目录。

`RetrievalAdapters(directory, request)` 仅在请求选择外部知识时打开已有的 `knowledge.sqlite`。知识库表为 `articles USING fts5(tenant UNINDEXED, title, body)`；`tenant` 来自可信控制器的请求，与每次 `target.namespace` 严格核对。SQL 参数全部绑定，模型不能选择表或租户。将 `adapters.providers` 注册到 `createRetrievalWorker`，将 `adapters.tools` 注册到 `createInteractionWorker`；在 `finally` 中关闭适配器。

网络配置来自可信请求的 `allowedOrigins`，搜索引擎由 `searchEngine` 选择。`wikipedia` 使用英文 Wikipedia 全文搜索；`brave` 复用 Core 已导出的 `createBraveWebSearchProvider`，读取 `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`。选择 Brave 却没有 Key 时失败，不降级。页面工具再次检查 origin 和 Runtime sandbox；任何重定向都拒绝。SDK、抓取、快照文件和 SQLite 连接均由应用管理。

外部知识库与 Memory 分离：`knowledge.sqlite` 提供外部检索内容，`memory.sqlite` 通过 Memory Worker 保存内部长期知识与任务检查点。内部知识使用 `knowledge:<tenant>:<key>`，检查点使用 `retrieval:<requestId>:<stage>`；内部检索只接受允许的知识 key，并校验类型与租户。内部模式不打开外部数据库。Redis Context 与 Memory 的共用初始化见 [storage](../storage/README.zh-CN.md)。应用目录及源文件应只允许可信控制器修改。

协议参考：[MediaWiki Search API](https://www.mediawiki.org/wiki/API:Search)、[SQLite FTS5](https://www.sqlite.org/fts5.html)。
