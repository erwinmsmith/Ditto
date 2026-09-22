# Ditto 节点体系覆盖与案例映射

[English](node-coverage.md) · **简体中文**

本说明将六个已有测试案例重新映射到[节点体系与 API Contract](13-node-api-contract.zh-CN.md)。案例只使用最终体系中已经明确的语义名称，不表示当前 dev 已经实现对应 Contract。

案例任务和交付约束沿用《节点体系覆盖》。展示统一采用“案例标题、任务、任务说明、顺序/节点/操作内容表”的格式。案例一的 23 行来自本次提供的完整截图；其余案例保留原文档图片中可见的 10、10、10、10、8 行，不补写未提供的电子表格行。完成状态、分数及日志以原测试记录为准，名称校正本身不构成一次测试执行。

## 统一归类规则

| 原说明中的标签或行为 | 当前归属 | 映射要求 |
| --- | --- | --- |
| CONTEXT.PROMPT | Graph bind 或应用输入装配 | 已有上下文装入或修改时才使用 CONTEXT.LOAD/UPDATE；只有取用已注册 Skill 才使用 CONTEXT.LOAD。 |
| CONTEXT.SCHEDULE | 应用编排与已有上下文、记忆节点 | 持久化调用 MEMORY.WRITE/UPDATE；当前条目选择或压缩使用 CONTEXT.SELECT/COMPRESS。没有同名节点。 |
| INTERACTION.MCP | INTERACTION.ACT.MCP | MCP 发现或调用是独立语义 Node；客户端连接、认证和 session 生命周期仍由应用/Runtime 管理。 |
| 接收任务或问题 | 应用/Runtime 输入边界 | 任务参数在 Graph 执行前进入系统，不是 Node；实际外部消息系统可通过 ACT.TOOL 或 ACT.MCP 调用。 |
| 选择检索路线标为 CONTEXT.SELECT | INFER.REASONING.DELIBERATE | 比较候选方案属于决策；SELECT 只对已有 Context 条目按 query 筛选。 |
| 任意历史文件或业务数据库标为 MEMORY.GET | 按寻址方式和生命周期区分 | 已知 id/key 的长期条目用 MEMORY.GET，结构化条件使用 MEMORY.QUERY；长期语义召回用 MEMORY.SEARCH；临时文件和实时业务状态用 ACT.TOOL/MCP。 |
| ACT 与 TOOL 表示同一层级 | `ACT` 是命名空间 | 直接注册工具使用 `INTERACTION.ACT.TOOL`，MCP 能力使用 `INTERACTION.ACT.MCP`；ACT 本身不作为可执行叶子。 |
| 评估、审批、重试、成本统计 | 测试侧或应用策略 | 不新增节点。真正执行验证工具可归 TOOL/ACT；推理和提示词不代替实际授权检查。 |

案例不得为了覆盖 21 个目标 Node Type 而插入原测试没有的行为。原 `INTERACTION.RUN` 是应用 Graph / Runtime 编排，不作为 Node；一次复合循环也不能替代对内部真实叶子 Node 的 trace 证据。

## RAG 的最终节点映射

| 操作 | 现有节点 | 边界 |
| --- | --- | --- |
| 获取网页、文件或第三方资料 | `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP` | 外部能力调用；取得的数据可成为当前任务 corpus。 |
| 检索当前任务知识 | `CONTEXT.SELECT` (rag strategy) | 面向当前文档、repo、网页、知识库或临时 corpus，结果进入 working context。 |
| 直接读取长期条目 | `MEMORY.GET` | GET 按 id/key 精确读取；QUERY 使用结构化条件。 |
| 语义检索长期记忆 | `MEMORY.SEARCH` | 面向跨 invocation/session 的 Memory Corpus。 |
| 长期状态生命周期 | `MEMORY.WRITE/UPDATE/DELETE + Graph/Policy` | 新建、修改、整理和淘汰持久语义状态。 |
| 基于证据推理并交付答案 | `INFER.REASONING.*`；`INTERACTION.OUTPUT` | RAG 不拥有生成；由选定的推理 Node 完成模型调用。 |

具体输入输出以 API Contract 为准。案例只确定语义归属，不虚构 CACHE 叶子或额外 RAG 阶段。

## 案例一 SWE-bench 真实代码修复

### 任务

从 SWE-bench Verified 选择一个真实 GitHub Issue，加载对应 commit 的代码仓库。Agent 需要定位缺陷、修改代码、运行测试，并提交 patch 和验证证据。

所有修改发生在一次性容器或临时 worktree 中，不推送到真实 GitHub。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | 在 Graph 执行前接收 Issue 描述、仓库版本和交付要求；该边界不是 Node。 |
| 2 | CONTEXT.LOAD | 加载 Issue、仓库树、基线 commit 和测试命令。 |
| 3 | MEMORY.SEARCH | 从长期 Memory Corpus 语义检索仓库约定、已知构建问题和此前修复经验。 |
| 4 | CONTEXT.SELECT | 从已加载上下文中选择与报错堆栈、符号和模块相关的证据。 |
| 5 | CONTEXT.LOAD | 读取已注册的代码修复约束，例如只修改必要文件、不得绕过测试；若未注册 Skill，则由 Graph bind 装配这些约束。 |
| 6 | INFER.REASONING.TRAJECTORY | 形成第一版故障假设。 |
| 7 | INTERACTION.ACT.TOOL | 使用代码搜索、文件读取和 Git diff 等已注册工具。 |
| 8 | INTERACTION.OBSERVE | 接收符号引用、调用路径和当前代码实现。 |
| 9 | CONTEXT.UPDATE | 将新发现的调用关系加入工作上下文。 |
| 10 | INFER.REASONING.SAMPLE | 按 count 生成多个修复候选，包括边界检查、状态修正和接口修正。 |
| 11 | INFER.REASONING.DELIBERATE | 比较候选的兼容性、影响范围和回归风险。 |
| 12 | INTERACTION.ACT.TOOL | 编辑选定文件并执行目标测试。 |
| 13 | INTERACTION.OBSERVE | 接收测试失败、堆栈、覆盖率或 lint 结果。 |
| 14 | INFER.REASONING.REFLECT | 对照原假设分析修复未通过的原因。 |
| 15 | CONTEXT.COMPRESS | 将长测试日志压缩为失败断言、涉及文件和关键变量。 |
| 16 | CONTEXT.UPDATE | 用压缩后的证据更新修复状态。 |
| 17 | INTERACTION.ACT.TOOL | 再次修改，并运行目标测试和回归测试。 |
| 18 | INTERACTION.OBSERVE | 接收最终测试结果和 Git diff。 |
| 19 | MEMORY.WRITE | 写入“问题、根因、修复、测试证据”的任务记忆。 |
| 20 | GRAPH: QUERY/SEARCH → INFER → UPDATE | 将多次失败经验合并为一条仓库级经验。 |
| 21 | MEMORY.WRITE | 将完整日志或日志 Reference 写入持久存储；最终 diff 和测试摘要已在步骤 15–16 保留于当前上下文。 |
| 22 | POLICY → MEMORY.DELETE | 淘汰无价值的临时搜索结果和过期故障假设。 |
| 23 | INTERACTION.OUTPUT | 输出 patch、修改说明、测试结果和剩余风险。 |

交付与验证：任务正文要求的修改和测试通过已注册 TOOL 执行；结果由 OUTPUT 交付。patch、基线 commit、测试命令和实际输出构成验证证据。不能用 INFER 的“测试通过”文本代替执行结果。

## 案例二 GAIA 多源事实调查

### 任务

从 GAIA 公开验证集选择一个需要网页检索、附件读取和数值计算的问题。Agent 必须提交精确答案，并保留来源、计算过程摘要和冲突处理记录。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | 在 Graph 执行前接收自然语言问题、附件和答案格式；该边界不是 Node。 |
| 2 | CONTEXT.LOAD | 加载问题、文件、日期限制及评测格式。 |
| 3 | CONTEXT.UPDATE | 将来源优先级、引用要求和禁止猜测规则加入工作上下文。 |
| 4 | INFER.REASONING.TRAJECTORY | 将问题拆成待验证事实和计算步骤。 |
| 5 | INFER.REASONING.SAMPLE | 按 count 产生多个检索路线和关键词组合。 |
| 6 | INFER.REASONING.DELIBERATE | 比较候选路线并选择检索方案。 |
| 7 | INTERACTION.ACT.TOOL | 调用网页搜索、浏览器、PDF 或表格读取工具。 |
| 8 | INTERACTION.OBSERVE | 接收网页、文档、表格和来源信息。 |
| 9 | CONTEXT.UPDATE | 将来源、日期、事实和可信度加入当前上下文。 |
| 10 | CONTEXT.SELECT | 按来源权威性、日期和证据完整性重排候选，并降低转载摘要权重。 |

交付与验证：计算使用任务配置的工具，答案及来源由 OUTPUT 交付。官方答案比对属于测试侧。此案例的公开网页搜索不自动计为长期 Memory 检索；只有已有测试实际使用持久知识库时才记录相应 Memory 调用。

## 案例三 τ²-bench 客户服务事务

### 任务

从 Airline 或 Retail 域选择一个涉及订单、预订、退款或换货的任务。Agent 与用户模拟器对话，读取企业政策和客户状态，在满足条件后修改沙箱数据库。

这个案例重点验证“Agent 有权提出操作”和“Agent 有权真正执行操作”之间的区别。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | 在 Graph 执行前接收用户的取消、改签、退款或换货请求；该边界不是 Node。 |
| 2 | CONTEXT.LOAD | 加载当前对话、业务域和可用工具说明。 |
| 3 | MEMORY.SEARCH | 从长期 Memory Corpus 语义检索客户交互经验；实时客户资料仍通过 ACT.TOOL 查询。 |
| 4 | INTERACTION.ACT.TOOL | 查询客户、订单、航班或商品状态。 |
| 5 | INTERACTION.OBSERVE | 接收真实沙箱业务记录。 |
| 6 | CONTEXT.UPDATE | 将订单状态、金额、时间和身份信息加入当前上下文。 |
| 7 | CONTEXT.LOAD | 读取已注册的退款政策、身份校验和审批边界；真实权限仍由工具和 Sandbox 检查。 |
| 8 | INFER.REASONING.TRAJECTORY | 判断用户请求对应的事务类型。 |
| 9 | INFER.REASONING.DELIBERATE | 检查政策条件、费用、资格和互斥操作。 |
| 10 | CONTEXT.SELECT | 只保留当前决定需要的客户与政策字段。 |

交付与验证：确认或澄清由应用通道承担；实际外部消息集成使用 ACT.TOOL 或 ACT.MCP。满足授权条件后由 ACT.TOOL 执行变更。以沙箱数据库最终状态和官方验证结果为准，不将建议、确认消息或上下文修改当作已执行退款。

## 案例四 MCPMark Verified 跨系统 CRUD

### 任务

从 MCPMark Verified 选择涉及 GitHub、Notion、Filesystem、Postgres 或 Playwright 的正式任务。Agent 必须先通过 MCP 发现能力，再完成查询、创建、更新、关联或删除等操作。

正式验证时使用官方发布任务及 verifier，不自行编写更简单的替代任务。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | APPLICATION/RUNTIME INPUT | 在 Graph 执行前接收任务目标和允许操作的 MCP server 范围；该边界不是 Node。 |
| 2 | CONTEXT.LOAD | 加载任务初始状态和 verifier 条件。 |
| 3 | INTERACTION.ACT.MCP | 通过 MCP 发现任务所需能力；客户端连接、认证和 session 生命周期仍由应用/Runtime 管理。 |
| 4 | INTERACTION.OBSERVE | 将服务能力、参数 schema 和资源描述接入 Agent 观察流。 |
| 5 | CONTEXT.SELECT | 选择完成任务所需的最小能力描述；真实权限仍由 ToolRegistry 和 Sandbox 实施。 |
| 6 | CONTEXT.UPDATE | 将禁止范围、幂等要求和删除审批规则加入上下文。 |
| 7 | MEMORY.SEARCH | 从长期 Memory Corpus 检索该服务的历史失败和参数限制；必须有实际经验库。 |
| 8 | INFER.REASONING.SAMPLE | 形成多个跨工具执行计划。 |
| 9 | INFER.REASONING.DELIBERATE | 比较计划对外部系统的影响、调用次数和回滚难度。 |
| 10 | INTERACTION.ACT.MCP | 调用读取型 MCP 能力；具体协议参数由后续 Contract 固定。 |

交付与验证：后续 CRUD 同样通过 TOOL 执行；官方 verifier 位于测试侧，实际被包装为工具调用时才记录 TOOL。无自动事务、回滚或审批保证。环境由应用提供 MCP SDK 连接；这不引入新的 MCP Node。

## 案例五 LongMemEval-V2 长周期记忆

### 任务

加载 LongMemEval-V2 的历史 Web/Enterprise Agent 轨迹。Agent 需要从多轮历史中建立持久记忆，在出现新事实、事实覆盖、环境陷阱和无关信息时管理记忆，最后回答官方问题。

这个案例专门覆盖整个 Memory 生命周期。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | CONTEXT.LOAD | 按时间顺序载入第一批历史轨迹。 |
| 2 | CONTEXT.SELECT | 选出事实、状态变化、工作流经验和环境陷阱。 |
| 3 | INFER.REASONING.TRAJECTORY | 判断哪些内容值得形成长期记忆。 |
| 4 | MEMORY.WRITE | 写入首次出现的稳定事实或经验，保存返回的 id。 |
| 5 | INFER.REASONING.DELIBERATE | 决定信息留在当前上下文、写入新记忆还是更新既有记忆。 |
| 6 | CONTEXT.COMPRESS | 将完整轨迹压缩为带来源指针的记忆摘要。 |
| 7 | CONTEXT.LOAD | 加载后续轨迹。 |
| 8 | INTERACTION.OBSERVE | 将轨迹接入环境历史观察结果。 |
| 9 | INFER.REASONING.DELIBERATE | 判断新信息属于补充、覆盖、冲突还是无关噪声。 |
| 10 | MEMORY.UPDATE | 用新状态更新旧条目，复用既有 id，并在 MemoryItem.content 中保留时间与来源。 |

交付与验证：原任务的全生命周期目标还要求检索、合并与淘汰的记录，分别对应 GET/QUERY/SEARCH 与用户 Graph/Policy 组合。只有实际测试出现相应操作并记录输入、返回 id 与后续可见状态，才算覆盖；不能仅凭案例名称或任务目标认定 5/5 已验证。官方问答评分与额外生命周期断言分开记录，回答经 INFER 与 OUTPUT 交付。

## 案例六 AFlow MATH 复现审计与 Smoke Test

### 任务

检查 AFlow 的 MATH 复现工程，确认 best-round 选择逻辑正确；加载已配置的 DeepSeek executor，在固定的 10 道 MATH 样本上完成真实 smoke test。

如果发现代码问题，Agent 可以修改本地工程并重新测试。最终保留 best-round 结论、10 道样本结果、代码修改、验证证据、API 调用、成本、失败和重试记录；不得启动正式 workflow search，也不得把 smoke test 分数冒充正式实验结果。

| 顺序 | 节点 | 操作内容 |
| --- | --- | --- |
| 1 | CONTEXT.LOAD | 加载任务目标、仓库边界和工作约束。 |
| 2 | MEMORY.GET | 恢复此前持久化的复现准备进度；工作区文件和日志仍通过 TOOL 读取。 |
| 3 | CONTEXT.SELECT | 选择需要进入当前工作上下文的历史信息。 |
| 4 | INFER.REASONING.TRAJECTORY | 判断下一步需要检查的入口和代码。 |
| 5 | INTERACTION.ACT.TOOL | 通过已注册工具读取仓库状态；MCP resources 需应用客户端适配。 |
| 6 | INTERACTION.OBSERVE | 接收代码、路径、commit、配置和工作流状态。 |
| 7 | CONTEXT.UPDATE | 将代码内容、版本信息和工作树状态加入当前上下文。 |
| 8 | INFER.REASONING.DELIBERATE | 深入分析 best-round 算法及 validation 重复结果处理。 |

交付与验证：任务正文规定的代码修改和 10 题运行经应用工具执行；DeepSeek 是该任务配置的 executor，不构成新的 Node Type。OUTPUT 交付实际结果、patch、验证依据、调用与成本记录及是否适合启动正式搜索的判断。重试和预算属于应用执行策略，不因展示需要新增节点。

## 证据与覆盖记录

正式覆盖记录应关联 case id、原样本/任务 id、代码 commit、实际 Node Type、输入输出引用、工具/Provider 实现和验证结果。同一个 Node 在 Graph 中重复出现可有不同逻辑 id；统计类型覆盖时去重。应用入口、bind、连接初始化与测试侧 verifier 均单独记录，不充作 Node。

《Agent 节点体系覆盖分析 · 报告》的 11/18 是此前 12 个样本对迁移前固定基线的离线分析；7 个未覆盖节点是当时的验证盲区。它既不是这六个案例的运行成绩，也不能换算成最终 21 个目标 Node Type 的覆盖率。最终覆盖必须按新全限定名称重新采集执行证据。

实现现状依据 dev 提交 a9e43212162650259b2a1bf9ed907d8bad19e79f 的 contracts、interaction loop 和 MCP 适配器；目标分类依据负责人最终商定的节点体系。案例任务依据提供的《节点体系覆盖》和《Agent 节点体系覆盖分析 · 报告》。原图只包含流程截图，没有完整电子表格附件，因此可见行数保持不变。
