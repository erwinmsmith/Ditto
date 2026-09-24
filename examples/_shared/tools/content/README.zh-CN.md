# 内容工具、校验与渲染

[English](README.md) · [应用工具](../README.zh-CN.md) · [七项流程](../../../capabilities/content/README.zh-CN.md)

本目录提供应用侧内容规则、源文件读取与文件发布。使用 Node.js 标准库，不新增第三方 SDK 或 Core 依赖。模型、Redis 和 SQLite Memory 由公开 Worker 工厂注册，连接配置见 [存储适配器](../storage/README.zh-CN.md)。

| 文件 | 职责 |
| --- | --- |
| [domain.ts](domain.ts) | 请求和来源描述、原文块、内容要求、草稿与复核校验 |
| [fixtures.ts](fixtures.ts) | 创建独立任务资料和固定输入清单，读取已有任务 |
| [tools.ts](tools.ts) | `content_sources` / `content_publish` 注册工具与文件生命周期 |
| [render.ts](render.ts) | 从同一结构化草稿生成 JSON、Markdown、HTML、来源快照及哈希清单 |

`contentTools(directory, request)` 返回 `RegisteredTool[]`，显式注入 `createInteractionWorker({ tools })`。工具执行通过 Runtime Graph，不直接调用 Worker 执行器。导入模块不会读取文件、打开连接、调用模型或发布产物。

`content_sources` 只读取控制器清单中的 `brief.md`、`notes.md`、`draft.md`，每个文件限制 16 KiB；验证常规文件、SHA-256 和原文块行号。资料按行形成证据块，Markdown 标题不作为事实块。本协议处理 UTF-8 文本资料，不是 PDF、Word 或通用 Markdown AST 解析器。

`content_publish` 再次校验原文快照、草稿和批准复核，渲染后逐文件写入并回读。文件名由应用固定，不接受模型路径。内容一致的重复写入允许恢复；不同内容失败，发布过程可能保留已成功写入的部分文件，但完整清单最后才写出。

HTML 中的标题、正文、原文引文均转义，页面不包含脚本；Markdown 正文的特殊字符转义。引用目标从已经验证的源文件与行号生成，模型无法提供任意 URL。输出目录及来源子目录拒绝符号链接。

引用原文逐字验证与来源覆盖是确定性检查；断言是否被所引用材料支持、翻译是否自然且不改变否定、改写是否符合语气要求，则由独立模型复核。复核失败阻止发布，不自动将结果改成通过。需要修改草稿要求时创建新任务，或在应用控制器中加入明确的编辑/修订流程。

使用独立目录保存每个任务。输入资料、SQLite、模型输出、复核、HTML 和测试报告均属于应用数据，已由仓库忽略规则排除；不要提交真实用户资料或凭据。

扩展模式由应用从已提交快照逐字保留原文首段，模型只生成新增分节；组合后统一校验和复核。
