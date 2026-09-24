# 七类控制流程：公开 API 组合与包验收

[English](control-flow.md) · [API 索引](README.zh-CN.md) · [全部控制流程](../../examples/control-flow/README.zh-CN.md)

控制流程通过稳定的组合入口构建：`graph` 声明节点和依赖，`loop` 声明状态迭代，`runtime.run` / `runtime.loop` 执行，Worker 工厂提供节点能力。38 个业务示例复用这些入口；无需为每个业务流程创建独立的 Core API。

## 能力映射

| 类别 | 示例数 | 公开组装和执行方式 | 应用提供的部分 |
| --- | --- | --- | --- |
| [顺序与步骤执行](../../examples/control-flow/sequence/README.zh-CN.md) | 4 | `graph().node()` 的依赖与绑定；分阶段 `runtime.run`；批量 `runtime.loop` | 输入校验、阶段验收、批量结果结构 |
| [条件与路由](routing.zh-CN.md) | 6 | 根据输入或节点结果选 Graph；`runtime.run`；依赖汇合；工具节点与输出节点 | 路由规则、风险与置信度阈值、PDF/OCR/ASR 等文件工具 |
| [并行与汇总](parallel.zh-CN.md) | 4 | 独立 Graph 分支、`runtime.run(plan, input, { concurrency })`、汇合依赖；多个 `runtime.run` 使用 `Promise.allSettled` 保留部分结果 | 计划约束、结果校验、报告和交付工具 |
| [循环与动态调整](iteration.zh-CN.md) | 6 | `loop({ graph, bind, update, done, maxIterations })`、`runtime.loop`；按状态选择下一轮 Graph | 目标标准、预算、检索与修订工具 |
| [异常、失败与恢复](recovery.zh-CN.md) | 8 | `runtime.run` / `runtime.loop`、`AbortSignal`、Context 节点、交互工具节点 | 检查点、备用策略、远端幂等核对与补偿协议 |
| [人工介入控制](human.zh-CN.md) | 5 | Graph + `INTERACTION.OUTPUT` 展示审核结果；重新进入 `runtime.run` 后继续；效果通过工具节点执行 | 身份认证、审核单、版本绑定、人工编辑和认领 |
| [任务生命周期控制](lifecycle.zh-CN.md) | 5 | Graph + `runtime.run`、取消信号和业务工具；定时/事件适配器调用公开流程入口 | 状态数据库、执行权、触发时间、事件去重和停止请求 |

并行运行的准确签名是 `runtime.run(plan, input, { concurrency, signal })`。普通条件判断、应用级等待或跨 Graph 的 `Promise.allSettled` 属于编排代码；它们选择和组合公开运行入口，不直接调用 Worker 执行器。

Graph 的依赖绑定只能读取明确声明的上游结果。节点返回的业务失败、模型失败或输出回执仍需应用检查；不要仅凭 Graph 返回就视为业务完成。相关示例对模型结束状态、工具结果、批准版本或效果记录进行实际校验。

## 包入口与扩展边界

控制流程及其工具使用以下公开入口：

| 入口 | 用途 |
| --- | --- |
| `@codesoul-co/ditto/runtime` | `createDitto`、`graph`、`loop`、运行时类型与配置加载 |
| `@codesoul-co/ditto/contracts` | Context、JSON、外部结果等公共契约 |
| `@codesoul-co/ditto/worker/context` | `createContextWorker` |
| `@codesoul-co/ditto/worker/infer` | `createInferWorker`、模型配置和公开结果类型 |
| `@codesoul-co/ditto/worker/interaction` | `createInteractionWorker`、`RegisteredTool`、`OutputSink` 等契约 |
| `@codesoul-co/ditto/worker/node` | 应用工具适配器使用的公开 `WorkerContext` 类型 |

模型请求经 `INFER.REASONING.SAMPLE` 与配置的 Provider 执行。业务副作用经 `INTERACTION.ACT.TOOL` 调用显式注册的工具；输出通过 `INTERACTION.OUTPUT` 和注入的 Sink 交付。示例不从 `src/`、`dist/`、未导出的深层路径加载实现，也不调用 `WorkerExecutor.execute()` 或 `WorkerDefinition.instantiate()` 自行执行能力。

`examples/_shared/tools/` 中的 SQLite、文件读写、HTTP 业务服务、解析器和外部 SDK 是应用扩展。把它们传给 `createInteractionWorker({ tools, output })`，是公开扩展契约的正常使用。人工审批、业务对象修改和事件生产属于可信应用控制器；这些操作直接修改应用自己的记录，不访问 Core 的内部状态。任务实验中的 Worker 包装仅记录真实执行轨迹，实际执行仍由 Runtime 调用，未替换模型或业务工具。

`runScheduled`、`runApproval` 等名称是示例应用导出的函数，不是 Core 包提供的业务方法。应用可复制相应示例及工具，或基于同样的公开 API 编写自己的流程。打包 Core 不应把 SQLite 业务规则、审批系统或第三方媒体依赖混入框架。

## 发布验收命令

```sh
# 无需模型凭据：检查全部示例的公开类型和包外加载
npm run check:examples:control-flow:types

# 配置 .env 后：安装两个独立包并运行全部七类真实任务实验
npm run check:examples:control-flow:package

# 单独运行顺序执行的包验收
npm run check:examples:sequence:package

# 按类别选择真实任务验收；类型与导入检查仍覆盖全部七类
npm run check:examples:control-flow:package -- --category human,lifecycle
```

可使用 `--provider <configured-provider>` 选择已配置的真实模型。路由验收还需要[文件采集工具依赖](../../examples/_shared/tools/file-ingestion/README.zh-CN.md)，可用 `--python /path/to/python` 或 `DITTO_EXAMPLE_TOOLS_PYTHON` 指定独立环境；其他类别不需要媒体工具环境。验收不会静默跳过缺失的工具依赖。

[统一验收脚本](../../scripts/check-control-flow-package.ts) 执行以下检查：

1. 扫描全部控制流程及共享工具，限制导入为 package.json 已导出的 Core 入口、Node 标准库和应用相对路径；禁止示例直接调用 Worker 执行器。
2. 分别构建、打包 Core 与可选检索包，记录 Core tarball 的 integrity；Core 包内容仅包含编译后的 `dist/`、包清单和 README。
3. 在仓库外创建消费应用，安装两个 tarball、Node 类型和 TypeScript；复制应用示例、工具及验收脚本，不复制包源码、仓库 tsconfig 或 `.env`。
4. 使用消费应用自己的严格 TypeScript 配置检查全部源码，不设置 `paths`、`baseUrl` 或源码符号链接。
5. 静默导入全部 38 个示例。运行时模块加载限制禁止访问消费应用外的模块，应用进入 Core 时必须使用公开包名入口；以源码路径、内部 dist 路径和绝对路径进行反向验证。
6. 对同一安装包依次运行选定类别的任务实验。模块限制继承到 Node 子进程，模型凭据仅通过环境变量传入。

共享工具的业务输入、输出文件和独立 Python 依赖由应用配置管理，不属于 Core 模块加载。定时触发由运行中的应用消费者负责；邮件、消息平台和审批系统需要各自的适配器，不由打包过程自动创建服务。

汇总报告是 `.examples-control-flow-package-live-results.json`，各类报告为 `.examples-control-flow-<category>-live-results.json`。报告记录同一 tarball 的摘要、导入检查、类型检查、每类场景结果和模型调用次数；真实任务产物仍保存在各自 `.examples-<category>-tasks/` 目录。顺序执行的验收检查 Context 依赖、阶段结果、批量汇总和输出 Sink，不要求外部业务数据库。

[边界回归测试](../../test/control-flow-boundary.test.ts) 随 `npm run check` 运行，用于阻止后续引入源码路径、未导出入口或直接执行 Worker。统一验收检查可安装和运行的产物，不执行 `npm publish`；报告中的 `packagePublishEnabled` 单独记录发布配置，不把安装测试通过等同于已发布。
