# 四、Agent 执行模式

[English](README.md) · [全部示例](../README.zh-CN.md)

执行模式将基础能力与控制流程组合为可复用的任务结构。每个目录介绍一种模式的流程、组成和接口边界。

| 模式 | 流程 |
| --- | --- |
| [4.1 RAG 文档问答](rag-qa/README.zh-CN.md) | 问题 → 文档检索 → 上下文选择 → 回答 → 来源引用 |
| [4.2 联网搜索问答](web-search-qa/README.zh-CN.md) | 问题 → 搜索 → 网页阅读 → 筛选 → 回答与引用 |
| [4.3 深度研究](deep-research/README.zh-CN.md) | 目标 → 计划 → 子问题 → 多轮检索 → 缺口识别 → 核验 → 报告 |
| [4.4 ReAct](react/README.zh-CN.md) | 模型判断 → 工具行动 → 观察 → 再次判断 → 完成 |
| [4.5 Plan-and-Execute](plan-and-execute/README.zh-CN.md) | 理解目标 → 生成计划 → 逐步执行 → 检查 → 必要时重规划 |
| [4.6 Reflection / Self-Refine](reflection/README.zh-CN.md) | 生成 → 检查 → 修订 → 再检查 |
| [4.7 多候选生成与选择](candidate-selection/README.zh-CN.md) | 生成多个候选 → 分别评估 → 选择或融合 |
| [4.8 工具链执行](tool-chain/README.zh-CN.md) | 读取输入 → 工具 A → 观察 → 工具 B → 核对结果 |
| [4.9 Human-in-the-loop](human-in-the-loop/README.zh-CN.md) | Agent 处理 → 展示结果 → 人工确认或编辑 → 继续 → 交付 |
| [4.10 多 Agent 分工](multi-agent/README.zh-CN.md) | 拆分任务 → 分配角色 → 各自执行 → 收集 → 汇总 |
| [4.11 Supervisor 模式](supervisor/README.zh-CN.md) | 主管理解 → 分配 → 专业 Agent 执行 → 主管检查 → 再分配或汇总 |
| [4.12 Agent Handoff](handoff/README.zh-CN.md) | 当前 Agent 完成职责 → 交接包 → 接收确认 → 转移责任 → 新负责人继续 |
| [4.13 专业 Agent 路由](specialist-routing/README.zh-CN.md) | 识别领域 → 选择专业 Agent → 执行 → 输出 |
| [4.14 多观点讨论](debate/README.zh-CN.md) | 独立观点 → 对比 → 共识与分歧 → 综合 |
| [4.15 自动修复](auto-repair/README.zh-CN.md) | 执行 → 读取错误 → 定位原因 → 修改 → 再执行 |
| [4.16 长任务与恢复](long-running/README.zh-CN.md) | 执行 → 保存检查点 → 中断 → 加载 → 核对 → 继续 |

Agent 表示任务角色与执行逻辑，Worker 表示能力实现与部署边界；示例应明确区分二者。

## 完整场景示例约定

以 [RAG 文档问答](rag-qa/README.zh-CN.md) 为调用与验收范例。执行模式从可信用户请求到实际产物串起完整链路，说明各阶段输入、输出、权限、停止条件及失败语义；不能只演示模型调用或单个节点。

每个场景提供可运行 CLI、程序调用、真实资料/系统接入、带出处的用户结果、持久化状态和恢复方式。Context 使用 Redis，Memory 使用数据库，业务与第三方工具单独配置。所有 Worker 通过公开包入口和 Runtime / Graph / Loop 组合，npm 消费者不依赖源码路径。

验收涵盖正常业务、缺失信息、异常、取消、进程中断和缓存过期，并验证实际产物及外部效果；真实模型与真实存储测试和显式替身单元测试分别报告。README 与 API 文档给出完整调用方法和适用边界。

[联网搜索问答](web-search-qa/README.zh-CN.md)
