# 3.4 信息整理与分析

[English](README.md) · [基础能力](../README.zh-CN.md) · [公开 API 与调用方法](../../../docs/worker-api/analysis-workflows.zh-CN.md)

这组示例将两个服务方案的多份资料整理成带来源的事实集合、冲突清单、核验结果和比较表。模型提取字段及原文引用，应用负责单位换算、去重、版本范围、参考资料权限、事实核验规则和结果计算。

| 能力 | 入口 | 可检查的结果 |
| --- | --- | --- |
| 多来源汇总 | [aggregate.ts](aggregate.ts) | 将不同格式和知识来源统一为记录，保留每条记录的来源与位置 |
| 信息去重 | [deduplicate.ts](deduplicate.ts) | 按对象、字段、期间和统一单位后的值合并重复记录，保留全部证据 |
| 冲突识别 | [conflicts.ts](conflicts.ts) | 找出同一对象、字段、期间的不同值；历史版本与当前版本分开 |
| 事实核验 | [fact-check.ts](fact-check.ts) | 将声明与可信控制器指定的参考资料比较，区分支持、否定、未核验和参考资料冲突 |
| 结构化提取 | [extract.ts](extract.ts) | 实际解析文本、PDF、HTTP 网页、CSV/XLSX、PNG，并提取对象、字段、数值和单位 |
| 信息转换 | [convert.ts](convert.ts) | 输出 JSON、CSV、Markdown，保留缺失值、核验状态和来源 |
| 比较分析 | [compare.ts](compare.ts) | 只用当前期间有参考依据的值比较对象，计算右侧对象减左侧对象的差值 |

七个入口共用完整流程并设置各自的 `focus`。每个文件导出 `run(runtime, input, options?)`，导入时不会连接 Redis、启动服务器或调用模型。业务适配器位于 [tools/analysis](../../_shared/tools/analysis/README.zh-CN.md)，框架调用均来自公开包入口。

## 安装与运行

使用 Node.js 24+，配置真实模型和 Redis。共享存储见 [storage](../../_shared/tools/storage/README.zh-CN.md)，PDF、表格和 OCR 工具见 [file-ingestion](../../_shared/tools/file-ingestion/README.zh-CN.md)。

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
# 使用已安装的解析器环境；否则按 file-ingestion 说明安装 Python、Poppler、Tesseract。
export DITTO_EXAMPLE_TOOLS_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
npm run example:analysis:aggregate
npm run example:analysis:deduplicate
npm run example:analysis:conflicts
npm run example:analysis:fact-check
npm run example:analysis:extract
npm run example:analysis:convert
npm run example:analysis:compare
```

Python 环境需要 Pillow、openpyxl、ReportLab；这组示例不使用语音转写依赖。模型和 `DITTO_WORKER_CONTEXT_REDIS_URL` 配置在 `.env`。所有 CLI 输出 `{ directory, result }`，每次创建独立的 `.examples-analysis-tasks/cli-*` 目录。

样例使用随机生成的保存天数和容量，建立十个来源：文本记录、改写副本、CSV、XLSX、两页 PDF 参考资料、包含冲突声明的图片、HTTP 网页、内部 Memory 知识、外部 SQLite 知识和历史版本。HTTP 网页是本地受控发布端，实际请求和解析，但不是公共互联网资料。测试材料中的服务方案为虚构对象。

## 产物

- `artifacts/analysis.json`：原始提取记录、未解决片段、归一化事实、重复组、冲突、核验状态和对象比较。
- `artifacts/facts.csv`：对象、字段、期间、数值、单位、核验状态和来源列表。
- `artifacts/analysis.md`：比较表、原文摘录及冲突清单。
- `snapshots/<sha256>/source.bin`：来源原始字节或知识记录 JSON；`<sourceId>-extracted.json` 保存解析文本与位置。
- `memory.sqlite`：通过 Memory Worker 管理的内部知识和任务检查点。
- `knowledge.sqlite`：外部系统示例数据，独立于 Agent Memory。

PDF 位置记录页码和提取后的行号；表格记录 sheet、行、列；OCR 记录识别文本的行号，不能当成图片像素坐标。表格单元格会转换为带对象和字段名的可读文本，引用与单元格位置一并保存。原文件摘要与解析器返回摘要不一致时停止，避免将读取期间变化的文件作为证据。

## 核验与比较规则

示例字段为 `retention_days`、`storage_gb`、`support_hours`。换算规则明确为一周七天、1 TB = 1000 GB；不把 TB 与 TiB 混用。原始值和单位保留在引用中，规范值用于去重和比较。

参考资料身份由可信控制器的 `Source.authority` 指定，模型不能授予。内外知识来源也不自动决定可信度：`origin` 表示数据归属，`authority` 表示本任务允许使用的参考级别。

| 核验状态 | 含义 |
| --- | --- |
| `supported` | 同对象、字段、期间有一致的参考值，且声明与之相同 |
| `refuted` | 有一致的参考值，但声明与之不同 |
| `unverified` | 没有可用参考值；重复来源再多也不会升级为已支持 |
| `disputed` | 参考资料本身提供多个不同值，保留争议并停止使用该字段作数值比较 |

这些状态表示与指定参考资料的关系，不代表开放世界的真伪证明，也不验证文档签名或发布者身份。更换真实业务时，应由应用配置参考来源及适用期间。比较只选当前期间的 `supported` 值；依据不足或参考冲突时，值与差值为 `null`，状态分别为 `unknown`、`disputed`。

每个输入片段必须被提取，或明确进入 `unresolved`。引用必须包含对应对象、字段线索、原数值与单位，并能在解析片段中逐字找到；不清晰或否定式陈述保留为未解决项。这是有明确字段和格式约束的分析流程，不是任意文档的无损理解器。默认 OCR 为英语、PDF 为文本层提取；扫描 PDF 可先转成图片接入 OCR。

## Context、Memory 与内外知识

Redis Context 保存本次任务上下文。数据库 Memory 使用 `analysis:<id>:request|sources|report` 保存检查点。内部知识使用 `knowledge:<tenant>:<name>`，通过 `MEMORY.SEARCH` 精确 key 范围读取，并校验租户和 `kind: knowledge`。外部知识通过 `RETRIEVAL.SEARCH` 的 `knowledge-external` Target 查询独立 SQLite 数据库。两种来源在报告中分别标为 `knowledge-internal`、`knowledge-external`，不会将任务缓存或历史报告当成内部知识。

```sh
npm run example:analysis:extract -- --sources-only
npm run example:analysis:extract -- --directory .examples-analysis-tasks/cli-XXXXXX
```

第二条命令使用第一条返回的实际目录。已归档来源不重新抓取或解析；因此恢复不需要重启样例 HTTP 页面。若来源归档前失败并需要再次读取样例网页，使用 `--serve-fixture` 在原端口重启受控发布端。真实应用则维护自己的来源服务。

缓存过期时从数据库 Memory 恢复；Redis 或 Memory 不可用时明确失败，不降级为本地缓存。Memory 提交前中断的步骤可以重做；报告提交后文件发布失败，仅重试幂等输出。同一 ID 绑定请求内容、来源期间和可信级别，变更需新 ID；调用方负责同一任务的串行推进。

## 验收

```sh
npm run check
npm run check:examples:analysis:tasks:package
```

包验收在仓库外安装实际 tarball，严格类型检查不使用 `paths` 别名，并限制 Core 只能从公开入口导入。完整任务使用真实模型、Redis、数据库 Memory、内部/外部知识、PDF/表格/OCR 工具与 HTTP 页面，检查最终报告和 CSV 回读结果。故障路径覆盖错误引用、遗漏片段、伪造可信度、参考冲突、无可靠参考、缓存过期、存储故障、坏文件、强制杀进程恢复与发布重试。单元测试使用显式模型和 Context 测试替身，不替代真实任务验收。

运行报告、快照、数据库、SDK 安装目录和 `AGENTS.md` 均被 Git 忽略。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
