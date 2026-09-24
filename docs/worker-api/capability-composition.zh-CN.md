# Agent 基础能力的公开 API 组合

12 类、86 个能力示例使用同一套公开 Worker 与 Runtime API。能力扩展主要通过 Graph、模型任务定义、工具和存储适配器完成；Core 提供稳定的执行和扩展契约，不要求为每一种业务语义增加一个节点。

## 能力与 API 对应

所有类别均使用 `CONTEXT.LOAD`、`MEMORY.GET/WRITE`、`INFER.REASONING.SAMPLE` 和 `INTERACTION.ACT.TOOL`，由一次 `runtime.loop(run*Loop, input)` 组合执行。计划通过 `yield* graphStep(graph, input, options)` 交出各阶段 Graph。

| 类别 | 入口数 | 能力如何完成 | 主要补充节点 / 扩展点 |
| --- | ---: | --- | --- |
| [请求理解与交互](../../examples/capabilities/understanding/README.zh-CN.md) | 6 | 模型提取目标/约束/意图，可信应用接收澄清回答与选项，保存多轮会话 | `CONTEXT.UPDATE`、`INTERACTION.OUTPUT`；工具和输出适配器 |
| [规划与任务管理](../../examples/capabilities/planning/README.zh-CN.md) | 5 | 模型提出子任务、依赖和工具计划，应用校验预算与资源并执行 | `CONTEXT.UPDATE`、`INTERACTION.OUTPUT`；业务计划校验器 |
| [信息检索与搜索](../../examples/capabilities/retrieval/README.zh-CN.md) | 8 | 模型改写/扩展查询，通过检索 Provider 获取结果并核对引用 | `RETRIEVAL.SEARCH`、`MEMORY.SEARCH`；内部 Memory 与外部知识库分开接线 |
| [信息整理与分析](../../examples/capabilities/analysis/README.zh-CN.md) | 7 | 汇总来源，提取、去重、比较及核验；应用校验结构与来源证据 | `RETRIEVAL.SEARCH`、`MEMORY.SEARCH`、`CONTEXT.UPDATE` |
| [上下文能力](../../examples/capabilities/context/README.zh-CN.md) | 5 | 显式 scope 加载、选择、组装、更新；模型摘要与上下文压缩组合 | `CONTEXT.SELECT/COMPRESS/UPDATE`；Redis Context store |
| [记忆能力](../../examples/capabilities/memory/README.zh-CN.md) | 4 | 检索、按规则写入、更新长期记忆，恢复任务进展 | `MEMORY.SEARCH/UPDATE`；`MemoryStore`，SQLite/PostgreSQL/Qdrant 适配器、EmbeddingProvider |
| [工具和系统操作](../../examples/capabilities/tools/README.zh-CN.md) | 10 | 模型选择允许的工具、补参数；工具实际操作服务、数据库、文件、容器、浏览器、桌面和消息系统 | `INTERACTION.OBSERVE`；`RegisteredTool`、Sandbox，第三方 SDK |
| [执行结果理解](../../examples/capabilities/observation/README.zh-CN.md) | 5 | 读取实际工具输出，归一化失败、更新状态并判断后续动作 | `INTERACTION.OBSERVE`、`CONTEXT.UPDATE` |
| [内容处理](../../examples/capabilities/content/README.zh-CN.md) | 7 | 模型生成、改写、总结、扩展、翻译，工具转换格式并交付带引用的产物 | `INTERACTION.OBSERVE`、`CONTEXT.UPDATE`；证据验证和文件渲染器 |
| [文档与多模态理解](../../examples/capabilities/multimodal/README.zh-CN.md) | 8 | 解析 PDF/Word、转写音频、提取视频帧；文本/视觉模型解释证据 | `INFER.REASONING.SAMPLE` 多模态消息、`INTERACTION.OBSERVE`；独立媒体工具 |
| [数据与代码能力](../../examples/capabilities/data-and-code/README.zh-CN.md) | 12 | 模型生成查询/程序/修改方案，工具执行 SQL、计算、绘图和受保护测试，核对真实结果 | `INTERACTION.OBSERVE`；应用数据库、代码隔离执行器和绘图工具 |
| [验证、评估与安全](../../examples/capabilities/validation/README.zh-CN.md) | 9 | 模型按证据评估质量；应用执行权限/策略/风险门禁，先脱敏再推理和保存 | `INTERACTION.OBSERVE`；可信授权、脱敏器、事务发布工具 |

模型调用本身不等于完成能力。每个任务还需要结构与证据校验、实际工具结果、持久检查点以及产物验证。权限、人工批准、预算、幂等和数据隔离由对应的可信应用规则落实；模型不能自行授予这些权限。

## 调用与扩展边界

调用链为：应用入口 → `createDitto({ workers, config, sandbox })` → `runtime.loop(Loop)` → `graphStep(Graph)` → 已注册 Worker → 应用适配器。Graph 用 `.node(id, publicNodeName, dependencies, mapper)` 声明节点和依赖；所有 Agent 操作都沿此调用链执行。

- `@codesoul-co/ditto/runtime`：`createDitto`、`graph`、`loop`、运行配置。
- `@codesoul-co/ditto/worker/context`：Context Worker、Redis store 契约、scope 和错误类型。
- `@codesoul-co/ditto/worker/memory`：Memory Worker 与持久化存储契约。
- `@codesoul-co/ditto/worker/infer`：推理 Worker、模型和消息类型。
- `@codesoul-co/ditto/worker/interaction`：Interaction Worker、工具、输出与观察契约。
- `@codesoul-co/ditto-retrieval` 及显式导出的 adapters 子入口：检索 Provider、Memory/Context 接线、embedding。
- `@codesoul-co/ditto/contracts`：跨 Worker 的公开结果和 JSON 类型。

第三方服务的 HTTP、数据库 SDK、PDF/OCR/ASR、浏览器和代码执行器位于 `examples/_shared/tools`，通过公开扩展接口注册。这些适配器内的服务调用属于工具实现。CLI 中创建输入夹具、接收人工回复、开关连接属于应用初始化与控制器职责。

验收脚本中的 Worker 包装用于记录真实调用、注入故障和模拟进程终止；它不属于示例的调用入口。应用目录禁止直接调用 `.instantiate()` / `.execute()`，也禁止从 Core 私有路径导入。

## npm 消费方式

`@codesoul-co/ditto` 的 tarball 包含 `dist` 中的公开实现和类型声明，通过 `package.json.exports` 消费。可选检索代码位于独立的 `@codesoul-co/ditto-retrieval` tarball。两个包都不包含源码目录、示例、业务工具、本地配置和测试产物。

消费者安装 Core 后，复制需要的示例目录及其相对依赖，安装对应 `examples/_shared/tools/*/dependencies/package.json` 中的第三方依赖，配置真实服务。示例里的 `run`、`runGoal`、`runPlan` 等是应用组合函数；它们没有作为 86 个业务方法加入 Core 的 exports。每个类别 README/API 文档提供具体接线与调用方法。

包检查先构建，再使用 `npm pack --ignore-scripts`，并在隔离的消费者环境中安装两个 tarball。检查验证可发布的包内容，不会上传到 npm。

## 统一发布检查

```sh
# 不需要模型和数据库：实际安装两个包、严格类型、86 个静默导入及边界负向探针
npm run check:examples:capabilities:types

# 每种能力复用一条完整业务任务的原有断言；Memory 默认覆盖三种后端
npm run check:examples:capabilities:package

# 12 类全部场景，包含原有故障注入、缓存过期、中断与恢复测试
npm run check:examples:capabilities:full

# 只运行选定类别的任务；编译和导入检查仍覆盖全部 86 个入口
npm run check:examples:capabilities:package -- --category context,memory --memory-backend sqlite
```

任务验收需要：文本模型、Redis；Memory 全后端还需 PostgreSQL、Qdrant 和真实 embedding；多模态需视觉模型与媒体 Python 环境；工具/代码需 Docker、浏览器和 Electron 运行环境。配置项及依赖安装见各类别 README 和 `.env.example`。不可用的依赖会导致失败，不会当作通过或退回进程内存。

统一检查只打包、安装一次 Core。消费者位于仓库外，无 TypeScript `paths` 别名、不复制 Core `src` 或 `.env`；运行时解析守卫禁止应用进入 Core 的未导出路径或解析仓库模块。机器报告包含 12 类节点矩阵、tarball 完整性、入口数及逐类真实任务结果。

`--coverage capabilities` 保留每个 mode 的第一条完整任务，包含原任务的交付断言；`--coverage complete` 执行所有场景。这个选择不替换模型或存储、不放宽验收断言。各模块原有 package 检查命令默认仍执行全量场景。类型/静默导入通过与实际任务通过在报告中分开记录。

报告为 `.examples-capabilities-package-live-results.json`，业务产物和逐类报告在忽略的 `.examples-capabilities-tasks/`。不要把 SQLite 结果当作其他数据库结果，或把局部类别通过当作全量 12 类通过。

逐能力任务直接调用对应示例导出的入口函数，验证从入口到实际产物的完整调用链；不是仅导入入口后绕过它调用共享实现。

[通过 Loop 组合 Graph](graph-loops.zh-CN.md)
