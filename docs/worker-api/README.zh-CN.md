# Worker 使用 API

[English](README.md) · **简体中文** · [文档地图](../README.zh-CN.md)

本目录以当前代码的公开入口为准，覆盖工厂、SDK 方法、全部 Worker 节点、Provider/存储适配器、注册表、配置和生命周期。每项操作都有调用示例；完整 TypeScript 示例放在 [examples](examples/README.md)，随 `npm run typecheck` 校验。类型定义不是自动数据库驱动或自动插件加载声明。

| Worker | 详细 API | 操作与示例 |
| --- | --- | --- |
| CONTEXT | [中文 API](context.zh-CN.md) · [English](context.md) | LOAD / SELECT / UPDATE / COMPRESS; Redis / TTL-LRU / stateStore / RAG / ReferenceResolver |
| INFER | [中文 API](infer.zh-CN.md) · [English](infer.md) | SAMPLE / TRAJECTORY / REFLECT / DELIBERATE / CACHE LOOKUP, WRITE, INVALIDATE; SDK + stream |
| MEMORY | [中文 API](memory.zh-CN.md) · [English](memory.md) | GET / QUERY / SEARCH / WRITE / UPDATE / DELETE; store / search |
| INTERACTION | [中文 API](interaction.zh-CN.md) · [English](interaction.md) | ACT.TOOL / ACT.MCP / OBSERVE / OUTPUT; ToolRegistry / McpRegistry / OutputSink |
| RETRIEVAL （可选） | [中文 API](retrieval.zh-CN.md) · [English](retrieval.md) | SEARCH; SDK / target / strategy / 独立部署 |

[Runtime / Graph / Loop 详细 API](runtime.zh-CN.md)：节点连接、Worker 分配、独立 Sandbox、本地 IPC 与跨机 HTTP。

[可移植检查点、隔离状态与 token 预算](checkpoints.zh-CN.md)：`@codesoul-co/ditto@0.1.1` 的 Graph/Loop 恢复、BranchStore 和 Provider 用量计费。

[Sandbox API](runtime.zh-CN.md#sandbox-api-与本地执行器)：权限、工作区读写、可替换执行器与真实本地命令执行。

[Worker 组合、事件与 Artifact](composition.zh-CN.md)：自定义 Node/Worker、resources/dispose、WorkerContext、数据引用及通信扩展。

[预定义流程 API](flows.zh-CN.md)：RAG、Skill、Tool、MCP、ReAct 的完整输入输出与调用示例。

[条件与路由 API 用法](routing.zh-CN.md)：六类应用路由、分支汇合、文件输入边界、独立工具配置与安装包调用。

[并行与汇总 API 用法](parallel.zh-CN.md)：并发控制、自动任务规划、依赖汇合与部分结果保留。

## 从哪里开始

1. 定义 Agent Graph：选择语义 Node、数据映射及失败时是否继续；不要把数据库连接、客户端或凭据放进 Graph。
2. 需要循环时定义 Loop：状态、更新规则、done 与 maxIterations。单轮直接 runtime.run，循环用 runtime.loop。
3. 定义 Worker 内部能力：模型 Provider、MemoryStore/search、RegisteredTool/McpClient/OutputSink。
4. 创建 Runtime 并注册 Worker；加载根目录 YAML 的行为参数和 env 的连接/凭据。
5. 只有需要独立检索资源时，显式导入并注册 RETRIEVAL；普通 MEMORY 原生检索不需要它。

完整流程见 [Graph + Loop + Worker](examples/graph-loop-worker.ts)；真实命令与普通工具组合见 [interaction-tools.ts](examples/interaction-tools.ts)。

## 返回值与错误：不要混用

| 调用层 | 返回 | 失败处理 |
| --- | --- | --- |
| INFER / MEMORY / RETRIEVAL SDK 或 Worker | `NodeResult<T>` | 检查 status 后读取 output；构造、路由或传输错误仍可能抛异常 |
| CONTEXT | `Context` / `ContextSelection` | 失败抛 ContextError 或服务异常 |
| INTERACTION | `ExternalResult` / `Observation` / MCP union / `OutputReceipt` | 直接检查各自 status；参数/权限/基础设施错误抛异常 |
| 底层 store / Provider / Sink | 各自原始 Output | 由对应 Worker 包装或校验；不要再套一层 NodeResult |

INFER 轨迹还有内层 output.status，外层 success 不等于轨迹 completed。取消或超时不表示外部操作已回滚；数据库、命令、MCP 与交付的幂等/重试由应用和适配器决定。

## 插件与配置专项

- [模型 Provider：注册/注销、HTTP、供应商协议、invoke/stream](providers.zh-CN.md)
- [检索 Provider：embedding、vector/text、RRF、rerank、SQL/Milvus 和 MEMORY 双向转接](retrieval-providers.zh-CN.md)
- [统一配置：根目录 ditto.yaml / .env 的字段、分组和优先级](configuration.zh-CN.md)

INTERACTION 的工具、MCP 实例与输出函数通过代码注入；YAML 支持 `workers.interaction.commands/webSearch` 行为参数；插件实例仍显式注入，不按插件名自动加载。数据库 SDK 与模型 SDK 生命周期由应用拥有，不逐请求创建或自动关闭。

## 示例目录

| 示例文件 | 覆盖 |
| --- | --- |
| [context.ts](examples/context.ts) | LOAD / SELECT / UPDATE / COMPRESS; scope / Redis / Graph |
| [memory.ts](examples/memory.ts) | 两个工厂、六个 SDK/节点、execute、分页、插件、错误、Graph、描述符 |
| [infer.ts](examples/infer.ts) | 两个工厂、七个叶子、五种策略、三种反思、四种审议、四个流、缓存及模型 Provider |
| [interaction.ts](examples/interaction.ts) | 工厂、注册/移除、四个节点、MCP、观察、回执、handler、Graph/Loop |
| [retrieval.ts](examples/retrieval.ts) | 工厂、SEARCH、Registry、embedding、融合/重排、数据库适配和 MEMORY 转接 |

[循环与动态调整 API 用法](iteration.zh-CN.md)：循环执行、动态重规划、迭代改进与检索、目标检查和停止条件。

[异常、失败与恢复 API 用法](recovery.zh-CN.md)：有原因的重试、备用路径、超时、检查点与会话恢复、暂停确认、补偿和副作用核对。

[人工介入控制 API 与示例](human.zh-CN.md)：确认后执行、中间结果确认、人工编辑后继续、审核发布和异常交接。

[任务生命周期 API 与示例](lifecycle.zh-CN.md)：状态跟踪、执行前状态检查、安全停止、定时触发与事件触发。

[七类控制流程的公开 API 边界与统一包验收](control-flow.zh-CN.md)：38 个示例的能力映射、包外严格类型检查及真实任务验证。

[请求理解与交互的公开 API 组合](understanding.zh-CN.md)：目标、约束、澄清、多轮会话、选项选择和意图处理。

[规划与任务管理 API](planning.zh-CN.md)：任务拆分、依赖构图、预算准入和工具选择，使用 Redis Context 与数据库 Memory。

[信息检索与搜索 API](search-workflows.zh-CN.md)：八项公开 API 组装示例，使用真实 Redis、数据库 Memory，执行文档、FTS 和联网检索并定位原文来源。

[信息整理与分析 API](analysis-workflows.zh-CN.md)：多来源汇总、去重、冲突、参考核验、结构化提取、转换和比较，保留来源并支持持久化恢复。

[上下文任务组装 API](context-workflows.zh-CN.md)：加载、选择、组装、语义摘要与裁剪、更新，使用 Redis 和数据库 Memory 完成任务与恢复。

[记忆任务 API](memory-workflows.zh-CN.md)：长期检索、规则写入、更新和任务状态保存，支持 SQLite、PostgreSQL 与 Qdrant。

[工具和系统操作 API](tool-workflows.zh-CN.md)：十项原生工具调用流程，实际操作核验、Redis/数据库检查点与独立包验收。

[执行结果理解 API](observation-workflows.zh-CN.md)：工具结果读取与解析、错误识别、事务性状态更新和基于证据的后续动作。

[内容处理 API](content-workflows.zh-CN.md)：七项生成与转换流程、证据校验、模型复核、可追溯引用和实际文件交付。

[文档与多模态理解 API](multimodal-workflows.zh-CN.md)：PDF/Word、图片、图表、音频、视频与会议记录，使用可追溯媒体证据和公开 Worker 组合。

[数据与代码能力 API](data-code-workflows.zh-CN.md)：十二项真实数据与源码流程，包含只读 SQL、容器执行、图表、测试及可追溯代码审查。

[验证、评估与安全 API](validation-workflows.zh-CN.md)：引用评估、可信策略门禁、推理前脱敏和可恢复发布。

[Agent 基础能力 API 组合与 npm 消费](capability-composition.zh-CN.md)：12 类、86 个入口的节点矩阵、扩展边界与统一发布检查。

[RAG 文档问答完整应用](rag-workflows.zh-CN.md)：可信请求、资料接入、检索筛选、上下文、答案、逐条引用与数据库恢复。

[Graph 与 Loop 组合](graph-loops.zh-CN.md)：Loop 统一控制阶段 Graph、分支、循环、预算和恢复。

[联网搜索问答](web-search-workflows.zh-CN.md)

[深度研究工作流](research-workflows.zh-CN.md)：子问题拆分、多轮补检、证据覆盖、持久化预算与引用报告。

[ReAct 持久化任务](react-workflows.zh-CN.md)：原生工具判断与观察循环、业务效果核对、Redis/Memory 恢复和真实浏览器任务。

[Plan-and-Execute 持久化任务](plan-execute-workflows.zh-CN.md)：整体计划、依赖与预算校验、真实业务执行、结果核对和剩余工作重规划。

[Reflection / Self-Refine](reflection-workflows.zh-CN.md)：生成、主动检查、双重校验、版本修订和持久化恢复。

[多候选生成与选择](candidate-workflows.zh-CN.md)：不同角度生成、独立评价、稳定排序、可追溯融合与复评。

[工具链执行](tool-chain-workflows.zh-CN.md)：串行、并行与条件依赖，真实 CRM 与通知入箱、幂等核对和持久恢复。

[Human-in-the-loop 人机协作](human-loop-workflows.zh-CN.md)：可信人工审核、版本化编辑、Redis/Memory 恢复与批准原文发布。

[多 Agent 分工](multi-agent-workflows.zh-CN.md)：角色资料隔离、并行/串行依赖、可核验交接与持久汇总。

[Supervisor 主管模式](supervisor-workflows.zh-CN.md)：主管检查、依据缺口再次委派、专业角色重试与持久管理历史。

[Agent Handoff 责任转交](handoff-workflows.zh-CN.md)：接收确认、原子责任转移、版本与交接链校验、工单恢复。

[专业 Agent 路由](specialist-routing-workflows.zh-CN.md)：主 Agent 分类、专业适配复核、限定工具任务、结果校验与恢复。

[多观点讨论](debate-workflows.zh-CN.md)：独立并行观点、逐项共识与分歧、保留少数意见的综合及恢复。

[自动修复](auto-repair-workflows.zh-CN.md)：真实错误反馈、受限修改、重新执行验证、修复产物及持久恢复。

[长任务与恢复](long-running-workflows.zh-CN.md)：持久分批检查点、已提交副作用核对、跨进程恢复与最终交付。
