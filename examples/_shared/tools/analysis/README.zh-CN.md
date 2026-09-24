# 信息分析应用工具

[English](README.md) · [七项能力示例](../../../capabilities/analysis/README.zh-CN.md)

本目录管理应用的材料、解析、证据和分析规则，不加入 Core 依赖或内部节点。

- `domain.ts`：请求与字段契约、单位换算、去重、冲突与参考核验、比较计算和报告序列化。
- `adapters.ts`：来源快照、文本/网页读取、材料标准化、外部 SQLite Provider 和本地报告工具。

复用 [file-ingestion](../file-ingestion/README.zh-CN.md) 的公开 RegisteredTool 实现完成 PDF、CSV/XLSX 和图片 OCR；复用 [retrieval/web.ts](../retrieval/web.ts) 的有界 HTTP 传输与 LinkeDOM 解析。内部知识由 [retrieval/memory.ts](../retrieval/memory.ts) 经 Memory Worker 显式入库，查询由分析 Graph 调用 `MEMORY.SEARCH`。Redis 与数据库 Memory 的初始化见 [storage](../storage/README.zh-CN.md)。

`AnalysisAdapters(directory, request, python)` 提供 `tools`、`providers` 和 `close()`。外部知识数据库表为 `documents(id, tenant, body)`，仅按已批准文档 ID 和绑定租户查询；内部 Memory 也核对 key、类型和租户。知识来源、参考级别、适用期间和页面 origin 由可信应用配置，模型不能更改。

工具名为 `analysis_read`、`analysis_normalize`、`analysis_report`、`analysis_publish`，以及复用的 `decode_pdf`、`read_spreadsheet`、`ocr_image`。在 `createInteractionWorker({ tools })` 中注册，在 `createRetrievalWorker({ providers })` 中注册外部 Provider，通过 Runtime 执行，结束时关闭适配器。

HTTP 只访问请求允许的 origin，拒绝重定向，20 秒超时、4 MiB 响应上限。生产 URL 使用 HTTPS；示例允许显式配置的 `127.0.0.1` HTTP 发布端。原始本地文件限普通文件和 4 MiB；标准化文本每来源最多 30 个片段、每片段最多 1200 字符。Memory 数据库、源文件与任务目录应仅由可信控制器修改。
