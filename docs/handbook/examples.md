# 选择并运行示例

示例按照“基础调用 → 控制流程 → Agent 能力 → 完整执行模式”递进。每个目录提供输入、依赖、运行命令、产物、失败处理和测试方式。第三方工具与数据库适配器集中在 `_shared/tools`，不混入框架依赖。

## 1. 下载消费者示例

文档站编译时生成 [ditto-examples.zip](/downloads/ditto-examples.zip)。解压后先阅读包内 README，执行 `npm install`；下载包直接从 npm 安装 Ditto，不需要私有源码或路径别名。

```sh
unzip ditto-examples.zip -d ditto-examples
cd ditto-examples
npm install
node examples/package-basics/context.ts 'Hello Ditto'
node examples/package-basics/tools.ts 'A😀'
```

需要模型时复制 `examples/package-basics/.env.example` 为 `.env`，填写模型与 Redis 配置。额外数据库、浏览器、OCR、音频与 MCP 依赖按照各例子的 README 安装。下载包不包含密钥、node_modules、数据库文件、测试产物或框架源码。

原始仓库中的 `npm run build` 构建框架；下载包是消费者项目，没有框架构建步骤。下载包的 example scripts 已移除此步骤。`check:*:package` 是维护者发布测试，依赖源码构建环境，不适用于下载包。

## 2. 从最小例子开始

| 示例 | 外部依赖 | 结果 |
| --- | --- | --- |
| [Context](../../examples/package-basics/context.ts) | 仅主包 | LOAD → SELECT 的真实输出 |
| [Tool](../../examples/package-basics/tools.ts) | 仅主包 | 字符统计与 Observation |
| [完整会话 Agent](../../examples/package-basics/agent.ts) | 模型、Redis、文件 SQLite | 多轮记忆、恢复、重放与答案文件 |
| [可选检索](../../examples/package-basics/retrieval.ts) | 主包 + 检索包 | 候选与来源 |
| [扩展与接入](../../examples/handbook/README.zh-CN.md) | 按具体示例 | 自定义 Worker、Skill、Memory 算法、真实 MCP |

## 3. 七类控制流程

[顺序与步骤](../../examples/control-flow/sequence/README.zh-CN.md)、[条件与路由](../../examples/control-flow/routing/README.zh-CN.md)、[并行与汇总](../../examples/control-flow/parallel/README.zh-CN.md)、[循环与调整](../../examples/control-flow/iteration/README.zh-CN.md)、[失败恢复](../../examples/control-flow/recovery/README.zh-CN.md)、[人工介入](../../examples/control-flow/human/README.zh-CN.md)、[生命周期](../../examples/control-flow/lifecycle/README.zh-CN.md)。

这层解释如何连接和控制能力。先找控制结构，再挑选对应 Node；不为每一种业务流程新增一套框架 API。[统一调用边界](../worker-api/control-flow.zh-CN.md)列出 38 个例子的公开节点映射。

## 4. 十二类基础能力

[基础能力索引](../../examples/capabilities/README.zh-CN.md)覆盖请求理解、规划、检索、分析、上下文、记忆、系统操作、执行结果理解、内容、多模态、数据代码、验证安全。

按业务目标选入口，再阅读其 `_shared/tools` 适配器。Context 使用 Redis，Memory 使用持久库；业务系统本身还需要独立状态核验。[统一能力与发布说明](../worker-api/capability-composition.zh-CN.md)提供 86 个入口的 API 矩阵。

## 5. 十六种完整执行模式

| 模式 | 建议先理解 | 关注的完整链路 |
| --- | --- | --- |
| [4.1 RAG](../../examples/patterns/rag-qa/README.zh-CN.md) | Context、Memory、检索 | 问题到带引用答案 |
| [4.2 联网问答](../../examples/patterns/web-search-qa/README.zh-CN.md) | Tool、网页读取 | 搜索、阅读、筛选和来源 |
| [4.3 深度研究](../../examples/patterns/deep-research/README.zh-CN.md) | Loop、预算 | 子问题、多轮检索、缺口和报告 |
| [4.4 ReAct](../../examples/patterns/react/README.zh-CN.md) | INFER actions、Tool/MCP | 判断、动作、观察直到停止 |
| [4.5 Plan-and-Execute](../../examples/patterns/plan-and-execute/README.zh-CN.md) | Graph 依赖、动态 Loop | 整体计划、执行与重规划 |
| [4.6 Reflection](../../examples/patterns/reflection/README.zh-CN.md) | 检查与版本 | 生成、发现问题、修改和复检 |
| [4.7 候选选择](../../examples/patterns/candidate-selection/README.zh-CN.md) | 并行、审议 | 生成、评价、选择或融合 |
| [4.8 工具链](../../examples/patterns/tool-chain/README.zh-CN.md) | Tool、副作用 | 查询客户、订单、更新与通知 |
| [4.9 人机协作](../../examples/patterns/human-in-the-loop/README.zh-CN.md) | 持久状态、可信审批 | 阶段结果、人工编辑、继续 |
| [4.10 多 Agent 分工](../../examples/patterns/multi-agent/README.zh-CN.md) | 角色上下文、并行 | 分工、执行、收集与汇总 |
| [4.11 Supervisor](../../examples/patterns/supervisor/README.zh-CN.md) | 检查、预算、再分配 | 主管检查与再次委派 |
| [4.12 Handoff](../../examples/patterns/handoff/README.zh-CN.md) | 原子责任状态 | 责任转移、接收确认和恢复 |
| [4.13 专业路由](../../examples/patterns/specialist-routing/README.zh-CN.md) | 条件、权限 | 领域判断与限定专业执行 |
| [4.14 多观点讨论](../../examples/patterns/debate/README.zh-CN.md) | 独立上下文、来源 | 共识、分歧与综合 |
| [4.15 自动修复](../../examples/patterns/auto-repair/README.zh-CN.md) | 实际执行反馈 | 报错、修改、再执行验证 |
| [4.16 长任务恢复](../../examples/patterns/long-running/README.zh-CN.md) | 检查点、业务幂等 | 中断、核对、继续与交付 |

## 6. 怎样复用

先复制模式目录和其相对导入的 `_shared` 应用模块，保持目录结构。替换请求身份、数据来源、业务工具、输出 sink 和配置；保留阶段契约、结果校验与恢复规则。

单独复制 cli.ts 通常不够。完整 archive 保留相对路径，方便先运行后删去不需要的部分。示例里 `runRag` 等函数是应用入口，不是 npm 框架导出。

## 7. 验证是否真的完成

每次验收记录实际运行环境、模型、存储和外部系统。检查最终文件/数据库/远端状态；分别验证新任务、重放、错误、取消、服务不可用和跨进程恢复。只通过 TypeScript 或模型能回答，不代表业务任务端到端成功。
