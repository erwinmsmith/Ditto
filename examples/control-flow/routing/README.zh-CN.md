# 2.2 条件与路由

[English](README.md) · [上一级](../README.zh-CN.md) · [全部示例](../../README.zh-CN.md)

使用公开的 Graph、Runtime、INFER 与 INTERACTION API 组合六类路由。应用选择要运行的 Graph，未选分支不执行；需要汇合的并行分支通过显式依赖连接。所有模块都可导入，导入时不读取配置、不请求模型、不执行业务操作。

## 示例与调用

| 文件 / 函数 | 输入与行为 | 命令 |
| --- | --- | --- |
| [state-routing.ts](state-routing.ts) / `runStateRouting` | `task: extract \| count` 选择处理图；`state: blocked` 优先返回阻塞状态 | `npm run example:routing:state-routing` |
| [conditional.ts](conditional.ts) / `runConditional` | 模型判断服务级别，校验 `priority \| standard` 后只执行对应分支，输出 expedited / normal 队列 | `npm run example:routing:conditional` |
| [branch-merge.ts](branch-merge.ts) / `runBranchMerge` | 独立提取 owner 和 deadline，两个分支均完成且有效才交付统一结果 | `npm run example:routing:branch-merge` |
| [file-type.ts](file-type.ts) / `runFileTask` | 原始文件 → 按类型调用解析工具 → 模型处理 → 交付 | `npm run example:routing:file-type -- --file <路径> --media-type <MIME>` |
| [risk.ts](risk.ts) / `runRisk` | 按可信风险值决定直接执行、独立核查、请求确认或人工处理 | `npm run example:routing:risk` |
| [confidence.ts](confidence.ts) / `runConfidence` | 应用验证器评估模型结果，决定返回、补充分析、重新执行或升级处理 | `npm run example:routing:confidence` |

要求 Node.js 24+、npm 11+。从仓库根目录执行 `npm ci`，按[配置 API](../../../docs/worker-api/configuration.zh-CN.md)设置 `.env` 中的模型、Provider 凭据与模型地址的网络白名单。命令显式加载 `.env` 和 `ditto.yaml`，使用实际 HTTP 模型；不注入模型替身。共享文件 [shared.ts](shared.ts) 仅提供本组示例的模型结果校验、交付与 CLI 初始化，编排保留在六个主题文件中。

公共函数接受调用方拥有的 Runtime，返回 `{ content, samples, receipt }`；风险路由另返回 `toolCalls`。`samples` 包含真实 `NodeResult<SampleOutput>`，可读取执行 ID、结束原因和 token 用量。调用方负责注册 Worker，并在 `finally` 中 `await runtime.close()`。安装包后的复制与调用方法见[路由 API 用法](../../../docs/worker-api/routing.zh-CN.md)。

## 输入边界

`runFileType` 接受 `ParsedFile`。PDF 使用 `text`，CSV/XLSX 使用带表头的二维字符串 `rows`，PNG/JPEG 使用 `ocrText`，WAV/MP3 使用 `transcript`。扩展名大小写不敏感；未知格式、MIME 与扩展名不匹配、空文本和不规则表格在请求模型前拒绝。

`runFileTask` 接收原始文件 `{ path, name, mediaType }`，先选择并调用 `INTERACTION.ACT.TOOL`，再将实际解析内容传给 `runFileType`。PDF 解码、CSV/XLSX 读取、图片 OCR 和音频转写工具均位于[文件采集适配目录](../../_shared/tools/file-ingestion/README.zh-CN.md)，包含独立依赖与配置方法。工具输出保留文件 SHA-256 和解析引擎，实验核对实际文件与结果。

## 风险策略

`risk` 必须是应用授权策略提供的有限数值，不使用模型生成的值作为操作权限。

| 范围 | 路由 | 行为 |
| --- | --- | --- |
| `[0, 25)` | execute | 调用 `record_pickup` 工具 |
| `[25, 50)` | verify | 将解析结果交给 `verify(value)`；仅严格返回 `true` 才调用工具，否则 pending_human |
| `[50, 75)` | confirm | 返回 pending_confirmation，不调用工具 |
| `[75, 100]` | human | 返回 pending_human，不调用工具 |

内存版示例工具 [pickup-ledger.ts](../../_shared/tools/pickup-ledger.ts) 通过 `RegisteredTool` 注册，实际写入调用方提供的内存 Map。相同请求 ID 和内容可重复执行，冲突内容拒绝；进程退出后不保留数据。接入持久业务服务时，由适配器实现鉴权、事务与幂等，保持工具契约一致。Core 不包含业务登记逻辑。

[pickup-task-store.ts](../../_shared/tools/pickup-task-store.ts) 提供 SQLite 任务队列、持久登记、审批记录和文件 OutputSink。任务实验验证 pending 时零业务写入、应用审批者批准后用 `resumeRisk` 恢复、拒绝后不可执行、修改已批准内容不可执行，以及恢复重试不重复登记。`resumeRisk` 调用可信的 `authorize(id, value)`，工具再次根据持久策略检查授权。审批记录绑定具体内容；测试由自动验收者提交批准/拒绝，不声称实际有人参与。普通 CLI 仍使用控制台 Sink，完整业务接入由任务实验演示。OUTPUT 接受通知不表示批准操作；交付失败不回滚已经完成的工具副作用。

## 置信度策略

`assess(value, attempt)` 是应用验证器，可异步返回 `[0, 1]` 中的有限值。`attempt=0` 评估初始结果；`attempt=1` 评估补救结果。验证器应基于独立证据或业务校验，不采用模型自报置信度。这些阈值是示例应用策略，不是模型准确率保证。

| 初始值 | 路由 | 行为 |
| --- | --- | --- |
| `[0.9, 1]` | return | 直接返回结果 |
| `[0.7, 0.9)` | analyze | 将候选结果与必填的补充 evidence 交给模型分析 |
| `[0.4, 0.7)` | retry | 让模型重新读取原始输入 |
| `[0, 0.4)` | escalate | 返回 pending_human |

最多执行一次补充分析或重试。复核值达到 0.9 才返回，否则升级为 pending_human；不会无限循环。最终结果保留初始 `route`、最终 `score` 和业务 `status`。

## 失败与交付

模型必须以 success / stop / assistant 文本完成，并通过 JSON 与字段校验。非法路由、截断响应、无效置信度、模型或工具失败均停止后续工作。分支汇合要求两个分支都有效，不能交付部分结果。Graph 视业务失败对象为数据，示例显式检查 status。交付回执必须 accepted；拒绝或未知结果不作为成功返回。

## 真实模型端到端验证

```bash
npm run check
npm run check:examples:routing:live
npm run check:examples:routing:package
# 可选：选择已配置的 Provider
npm run check:examples:routing:package -- --provider deepseek
```

live 使用随机记录标识和数量，执行 24 个用例：两种任务路由及阻塞状态、两个条件分支、分支汇合、七种文件格式的解析结果、五条风险路径、六条置信度路径。检查真实模型输出、所选 Graph、模型调用次数、唯一最终交付、工具实际写入，以及需要确认或人工处理时零业务写入。置信度策略测试显式提供验证器分值以覆盖阈值，不把这些分值作为模型测量结果。

package 先打包并在临时应用中安装 npm tarball，复制示例和应用工具，使用不含 paths 别名的严格 TypeScript 配置验证公开导出，再执行同一组真实模型测试。它不依赖包内 `src`，不复制凭据文件，退出时清理临时应用。

报告分别保存在 `.examples-routing-live-results.json` 与 `.examples-routing-package-live-results.json`，记录 Provider、模型、时间、逐用例输入预期与输出、Graph 路径、执行 ID、token 用量、调用及交付次数。失败返回非零退出码。离线回归补充无效输入、未选分支、汇合等待、拒绝交付、工具失败、权限拒绝、幂等和有限重试检查。

## 任务级端到端实验

先按[文件工具安装说明](../../_shared/tools/file-ingestion/README.zh-CN.md)安装示例侧解析依赖，再运行：

```bash
npm run check:examples:routing:tasks
npm run check:examples:routing:tasks:package
```

任务验收执行 27 个用例，检查业务完成条件而非仅检查模型成功：

- 从磁盘任务输入开始，校验提取报表、分派队列、两个分支共同生成的交接文件，以及阻塞后恢复。
- 实际生成并处理 PDF、CSV、XLSX、PNG、JPEG、WAV、MP3；解析器只接收文件路径与 MIME，测试预期不传给工具或模型。
- 风险任务从待确认/待人工处理进入批准、执行或拒绝；核对真实 SQLite 行、批准内容绑定、未授权调用拒绝和重复执行幂等。
- 置信度由模型结果与独立证据文件的匹配比例计算；补充分析或重试后重新核验，不向验证器直接返回固定分数。分值表示实验的证据覆盖率，不表示模型校准概率。
- 每个正常结果重新读取交付 JSON 和数据库状态；损坏文件产生持久失败记录，无模型调用和业务写入。最后关闭并重开 SQLite，验证记录保留。

原始文件、任务输入、证据、审批记录、交付 JSON 与 `tasks.sqlite` 保留在 `.examples-routing-tasks/run-*/`。报告分别为 `.examples-routing-tasks-live-results.json` 和 `.examples-routing-tasks-package-live-results.json`，记录产物目录、工具调用、解析结果、文件摘要、模型执行和任务状态。缺少解析依赖、产物不匹配或任务状态错误均使实验失败。

`check:examples:routing:live` 是路由契约检查；完整任务验收使用带 `tasks` 的命令。SQLite 适配器面向本地示例，调用方负责业务身份认证；审批队列与 JSON 文件不提供跨存储事务或分布式任务调度。
