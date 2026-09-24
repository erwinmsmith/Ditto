# 3.3 信息检索与搜索

[English](README.md) · [基础能力](../README.zh-CN.md) · [公开 API 与调用方法](../../../docs/worker-api/search-workflows.zh-CN.md)

将问题转成检索查询，从真实文件、SQLite 知识库或互联网获取资料，生成可回溯原文的证据简报。模型负责查询选择和摘录选择；应用校验查询契约、来源 ID、逐字引用和来源覆盖，再写出 JSON、Markdown 报告。

| 能力 | 入口 | 执行内容 |
| --- | --- | --- |
| 文档检索 | [document-search.ts](document-search.ts) | 读取指定 Markdown 文件，以关键词检索内容，记录文件 URI、行号和原始快照 |
| 知识库检索 | [knowledge-base.ts](knowledge-base.ts) | 区分内部 Memory 知识与外部知识库，可分别检索或合并，保留各自来源 |
| 联网搜索 | [web-search.ts](web-search.ts) | 调用搜索引擎，读取允许来源的实际页面；搜索摘要仅用于发现页面 |
| 网页阅读 | [web-read.ts](web-read.ts) | 读取指定 HTML 页面，提取正文，保存 HTML 和提取文本 |
| 多来源检索 | [multi-source.ts](multi-source.ts) | 分别检索文档、知识库和互联网，合并证据；显式允许时保留部分来源结果 |
| 查询改写 | [rewrite.ts](rewrite.ts) | 将口语问题改写为索引支持的词表查询，并执行改写后的查询 |
| 查询扩展 | [expand.ts](expand.ts) | 从词表选择 2–3 个不同查询，分别执行、去重并保留查询来源 |
| 来源定位 | [source-location.ts](source-location.ts) | 将摘录关联到文件行、数据库记录或网页正文行，并附快照 SHA-256 |

每个入口导出 `run(runtime, input, options?)`，导入模块不会连接服务或运行任务。入口复用 [shared.ts](shared.ts) 的 Runtime Graph；第三方工具和依赖位于 [tools/retrieval](../../_shared/tools/retrieval/README.zh-CN.md)。

## 运行

需要 Node.js 24+、真实 Redis 和已配置的模型。按[存储说明](../../_shared/tools/storage/README.zh-CN.md)配置 `DITTO_WORKER_CONTEXT_REDIS_URL`，在 `.env` 配置模型 Provider。

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
npm run example:retrieval:document-search
npm run example:retrieval:knowledge-base
npm run example:retrieval:web-search
npm run example:retrieval:web-read
npm run example:retrieval:multi-source
npm run example:retrieval:rewrite
npm run example:retrieval:expand
npm run example:retrieval:source-location
```

命令生成独立任务目录并输出 `{ directory, result }`。样例资料中的保存天数和备份间隔随机生成，报告必须引用此次任务的实际资料。产物包括：

- `request.json`、`policy.md`、`internal-knowledge.json`、`knowledge.sqlite`：任务输入、内部知识导入资料和独立外部知识库。
- `memory.sqlite`：通过 `MEMORY.*` 管理的内部知识与任务检查点；两者使用不同 key 命名空间。
- `snapshots/<sha256>/`：原文或数据库记录快照；网页另存 `extracted.txt`。
- `artifacts/brief.json`、`artifacts/brief.md`：包含状态、查询、证据、引用和失败来源的报告。

默认联网搜索是 **Wikipedia 站内全文搜索**，无需 API Key；它的覆盖范围仅限 Wikipedia。通用互联网搜索可将新任务的 `request.searchEngine` 设置为 `brave`，配置 `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`，并由可信应用配置 `allowedOrigins`。不会静默切换搜索引擎。默认网页阅读使用 SQLite 官方文档；不执行 JavaScript，也不处理登录页面。

## 内部与外部知识库

这里的内外以 Agent 的知识管理边界为准，不以数据库是否部署在本机或公网为准。企业内网数据库、搜索服务或知识平台也可以作为外部知识库接入。

| 类型 | 数据归属与调用链 | 结果来源 |
| --- | --- | --- |
| 内部知识库 | Agent 已明确接收并保存的长期知识，通过 `MEMORY.WRITE` 入库、`MEMORY.SEARCH` 检索 | `knowledge-internal`，URI 为 `memory:knowledge:<tenant>:<key>` |
| 外部知识库 | 独立数据库或系统拥有的资料，通过 `RETRIEVAL.SEARCH` 及应用 Provider 检索 | `knowledge-external`，保留外部记录定位 |
| 任务记忆 | 请求、查询、证据和报告检查点，通过 `MEMORY.GET/WRITE` 恢复任务 | 使用 `retrieval:<requestId>:<stage>`，不参与内部知识检索 |

示例默认选择 `external`，独立 SQLite FTS5 数据库演示外部知识源适配器；内部模式使用 `memory.sqlite`，无需打开 `knowledge.sqlite`。

```sh
npm run example:retrieval:knowledge-base -- --knowledge internal
npm run example:retrieval:knowledge-base -- --knowledge external
npm run example:retrieval:knowledge-base -- --knowledge both
npm run example:retrieval:multi-source -- --knowledge both
```

请求字段 `knowledge` 由可信控制器选择；`internalKnowledgeKeys` 是允许检索的当前租户知识 key 列表。内部检索通过 `MEMORY.SEARCH` 的精确 key 过滤，随后校验 `content.kind === "knowledge"` 与租户。不会将任务归档当成知识，也不会跨租户查询。

CLI 创建内部或混合模式的新任务时，从 `internal-knowledge.json` 经公开 `MEMORY.WRITE` 导入样例知识；恢复时不重新导入。应用接入使用 [importInternalKnowledge](../../_shared/tools/retrieval/memory.ts) 显式导入经过确认的内容；Agent 不会自动把模型回答或外部检索结果升级为内部知识。已有 Memory 的应用可以直接提供允许的知识 keys。

混合结果不会隐式认定内部或外部来源更可信，也不会合并成单一事实；原文、来源类型和快照分别保留。`allowPartial` 同样适用于内外知识源之一失败的情况。

## 检查点与继续执行

```sh
npm run example:retrieval:expand -- --stop-after evidence
# 将任务输出的目录填入 --directory
npm run example:retrieval:expand -- --directory .examples-retrieval-tasks/cli-XXXXXX
```

`--stop-after` 支持 `queries`、`evidence`。同一任务在已有 Memory 检查点之后继续执行；已归档的证据与报告不重新请求模型或外部来源。Redis 缓存过期时从数据库 Memory 恢复，Redis 或 Memory 不可用时直接失败。报告文件写入失败可重试；Memory 提交前失败的步骤可能重新执行。一个任务由一个控制器串行推进，不提供跨控制器的分布式互斥。

请求 ID 与内容绑定。更改问题、来源、租户或检索配置时创建新任务 ID；若要抓取资料的新版本，也创建新任务。恢复始终使用已归档的资料版本。

## 结果与边界

`completed` 表示检索和简报生成完成；没有命中时返回 `no-evidence`，不生成虚构引用。来源异常默认阻止报告；`allowPartial: true` 时，仅在仍有有效证据的情况下返回 `partial` 并列出不可用来源。空命中与来源故障分开处理。

报告采用可校验的原文摘录，不把模型生成的自由结论视作事实。逐字匹配证明引用存在于保存的材料中，不代表资料权威性、实时性或结论已被独立核实。文档示例使用按行关键词匹配，外部知识库使用 SQLite FTS5，内部知识使用 Memory 数据库的关键词查询，改写与扩展使用调用方提供的受控词表；接入其他索引时可替换公开 Retrieval Provider。

每个查询最多检索 3 条文档或外部知识记录；内部知识最多配置 12 个精确 key，每个 key 最多返回 1 条记录；搜索引擎最多返回 5 个候选并读取首个允许来源，直接网页模式最多读取 2 页。正文每页最多选 2 段，每段最多 1000 字符。网页只允许配置的 HTTPS origin，拒绝重定向，单次请求超时 20 秒，响应上限 4 MiB。来源是非可信数据，不能授权工具或扩大网络范围。

## 验收

```sh
npm run check
npm run check:examples:retrieval:tasks:package
```

包验收在仓库外安装实际 npm tarball，使用无 `paths` 别名的严格类型检查和运行时模块边界检查。任务验收使用真实模型、Redis、SQLite Memory/FTS、文件和互联网页面，校验实际报告、引用位置、缓存过期、存储故障、跨进程强制中断、来源缺失、错误引用和报告写入重试。默认验收覆盖 Wikipedia；Brave 需要独立配置并运行对应任务。SQLite 验收不等同于 PostgreSQL/MySQL 验收。`AGENTS.md`、运行产物、依赖安装目录和数据库均被 Git 忽略。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。

多来源计划按来源顺序执行，在允许部分结果时保留成功来源并单独记录失败来源，不承诺来源请求并发。单个 Graph 内的独立节点仍可并发执行。
