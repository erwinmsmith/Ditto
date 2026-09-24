# Ditto 示例

[English](README.md) · [项目首页](../README.zh-CN.md) · [API 参考](../docs/worker-api/README.zh-CN.md)

本目录围绕控制流程、Agent 基础能力和执行模式组织示例主题，介绍从单项能力到完整任务模式的组合方式。

## 目录导航

| 目录 | 内容 |
| --- | --- |
| [control-flow](control-flow/README.zh-CN.md) | 7 类控制流程：顺序、路由、并行、循环、恢复、人工介入、生命周期 |
| [capabilities](capabilities/README.zh-CN.md) | 12 类基础能力：理解、规划、检索、分析、上下文、记忆、工具、观察、内容、多模态、数据与代码、验证 |
| [patterns](patterns/README.zh-CN.md) | 16 种执行模式：RAG、ReAct、研究、反思、多 Agent、自动修复与长任务等 |
| [_shared](_shared/README.zh-CN.md) | 共用配置与静态素材 |

```text
examples/
├── README.md / README.zh-CN.md
├── quickstart.ts
├── control-flow/       # 每个主题一个 .ts 文件
├── capabilities/       # 每个主题一个 .ts 文件
├── patterns/           # 每个模式一个目录
└── _shared/            # 共用配置与素材
```

各目录 README 介绍主题、流程、组成和接口边界。[quickstart.ts](quickstart.ts) 提供本地入门入口，模型、数据库和部署接入代码见下方 API 示例。

## 快速开始

要求 Node.js 24+、npm 11+。从仓库根目录执行：

```bash
npm ci
npm run example:quickstart
```

Quickstart 执行 CONTEXT.LOAD → SELECT，返回包含 `Hello Ditto` 的 ContextSelection；无需 `.env`、模型、数据库或 MCP。导入模块不自动执行任务。

## 组织约定

- 控制流程描述步骤如何流转；基础能力描述单项功能；执行模式描述两者的组合。
- 单项主题使用独立文件；模式使用 `index.ts`，专用工具、状态类型和素材放在同一目录。
- 使用 `@codesoul-co/ditto` 公开入口，Graph、Loop 和状态转换保留在各示例中。
- 共用配置与素材放在 `_shared/`，避免从其他示例入口导入任务编排。
- 审批、重试、检查点持久化和任务交接由应用编排；Agent 角色与 Worker 部署边界分别定义。
- 外部模型、SDK、存储与执行器由应用配置，凭据通过环境变量提供，资源在 `finally` 中关闭。

在仓库根目录运行 `npm run typecheck` 检查 TypeScript 类型。

## 验证要求

验收终点是任务的业务结果。模型请求成功、工具返回 success 或 Graph 完成只是中间证据；必须从实际任务输入运行到可检查的交付产物或明确的失败、阻塞、审批、人工队列状态。文件流程使用真实文件并调用实际解码/OCR/转写工具，写入流程重新读取存储验证业务记录，审批流程验证批准、拒绝和恢复，重试流程验证副作用不重复。涉及持久化时，在关闭并重开存储后复核结果。

每个示例的验收覆盖输入、Graph 调度、真实依赖、结果校验和最终输出。涉及模型的链路必须调用真实 Provider；控制流程示例通过组合真实模型步骤验证上游数据确实参与推理。涉及数据库、工具或其他外部系统时，使用其实际接入链路验证。

单元测试和类型检查用于快速回归；端到端验证使用独立命令，显式加载凭据，并记录模型或服务、运行时间、关键输入输出及通过/失败结果。验证失败应非零退出，不以替身或固定答案代替真实依赖。使用公开包入口，并在包安装环境验证类型解析和运行方式。

顺序执行的运行方法见[真实模型端到端验证](control-flow/sequence/README.zh-CN.md#真实模型端到端验证)。

## API 接入示例

[API 示例目录](../docs/worker-api/examples/README.md) 提供公开接口的调用方式与接入参考：

- [接入指南](../docs/worker-api/examples/guide.zh-CN.md)：模型、MCP 与联调配置。
- [Runtime 接入](../docs/worker-api/examples/runtime/README.zh-CN.md)：部署、事件、Artifact 与预定义流程。
- [数据库接入](../docs/worker-api/examples/integrations/README.zh-CN.md)：Redis、SQL、Milvus 与检索。

条件与路由的运行和真实模型验收见[六类路由示例](control-flow/routing/README.zh-CN.md)。

条件与路由的完整任务实验：`npm run check:examples:routing:tasks:package`。安装与工具配置见[文件采集工具](_shared/tools/file-ingestion/README.zh-CN.md)。

并行与汇总的完整任务实验：`npm run check:examples:parallel:tasks:package`，见[四类并行流程](control-flow/parallel/README.zh-CN.md)。

循环与动态调整的完整任务实验：`npm run check:examples:iteration:tasks:package`，见[六类循环流程](control-flow/iteration/README.zh-CN.md)。

异常、失败与恢复的完整任务实验：`npm run check:examples:recovery:tasks:package`，见[八类恢复流程](control-flow/recovery/README.zh-CN.md)。

[人工介入控制 API 与示例](control-flow/human/README.zh-CN.md)：确认后执行、中间结果确认、人工编辑后继续、审核发布和异常交接。

[任务生命周期 API 与示例](control-flow/lifecycle/README.zh-CN.md)：状态跟踪、执行前状态检查、安全停止、定时触发与事件触发。

[七类控制流程的公开 API 边界与统一包验收](../docs/worker-api/control-flow.zh-CN.md)：38 个示例的能力映射、包外严格类型检查及真实任务验证。

[请求理解与交互](capabilities/understanding/README.zh-CN.md)：六项能力与完整报告任务；包验收命令 `npm run check:examples:understanding:tasks:package`。

[Context / Memory 存储接入](_shared/tools/storage/README.zh-CN.md)：Agent 示例使用 Redis Context 与数据库 Memory；应用状态库独立保存业务事务。后续示例遵循相同存储与端到端验收约定。

[规划与任务管理](capabilities/planning/README.zh-CN.md)：五项能力与实际补货任务；包验收命令 `npm run check:examples:planning:tasks:package`。

[文档与多模态理解](capabilities/multimodal/README.zh-CN.md)：八项能力、原始媒体解析和完整任务验收；包验收命令 `npm run check:examples:multimodal:tasks:package`。

[数据与代码能力](capabilities/data-and-code/README.zh-CN.md)：十二项能力与完整业务结果验收；`npm run check:examples:data-code:tasks:package`。

[验证、评估与安全能力](capabilities/validation/README.zh-CN.md)：九项能力、发布门禁及完整任务验收；`npm run check:examples:validation:tasks:package`。

全部 Agent 基础能力的统一发布检查见 [公开 API 组合](../docs/worker-api/capability-composition.zh-CN.md)。
