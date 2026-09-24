# 能力与调用链索引

[English](node-coverage.md) · **简体中文** · [完整 API](worker-api/README.zh-CN.md)

当前 Core 有 21 个可路由叶子；可选 RETRIEVAL 增加 SEARCH。下表按实际实现说明每个能力如何使用。模型、数据库、MCP 及交付端由应用配置；声明了 Node 类型并不表示已有对应服务。

## 已实现的节点

| Node | 实际执行与调用文档 |
| --- | --- |
| `CONTEXT.LOAD` | 从消息/条目/引用构建 Context，或读取已缓存 scope；显式开启时解析引用。[API](worker-api/context.zh-CN.md) |
| `CONTEXT.SELECT` | 按 purpose、query、预算与策略返回 ContextSelection；不回写 scope 缓存。[API](worker-api/context.zh-CN.md) |
| `CONTEXT.UPDATE` | 增删替换条目，将 ContextIngress 并入 working set。[API](worker-api/context.zh-CN.md) |
| `CONTEXT.COMPRESS` | 默认按策略和预算裁剪，保护指定条目/关联组；不默认调用模型生成摘要。[API](worker-api/context.zh-CN.md) |
| `INFER.REASONING.SAMPLE` | 单次模型调用，返回 message、actionRequests、usage 等；不执行动作。[API](worker-api/infer.zh-CN.md) |
| `INFER.REASONING.TRAJECTORY` | 执行 CoT、Long CoT、ToT、GoT、Self-consistency 或注入策略；有界组织公开结果与轨迹。[API](worker-api/infer.zh-CN.md) |
| `INFER.REASONING.REFLECT` | critique / verify / revise 已有候选。[API](worker-api/infer.zh-CN.md) |
| `INFER.REASONING.DELIBERATE` | 单次模型调用处理 select / merge / consensus / debate，返回校验后的候选评估与结果。[API](worker-api/infer.zh-CN.md) |
| `INFER.CACHE.LOOKUP` | 从注入缓存查询计算结果。[API](worker-api/infer.zh-CN.md) |
| `INFER.CACHE.WRITE` | 显式写入计算缓存，按后端支持处理 TTL 等参数。[API](worker-api/infer.zh-CN.md) |
| `INFER.CACHE.INVALIDATE` | 按 key/tag/namespace 使缓存失效。[API](worker-api/infer.zh-CN.md) |
| `MEMORY.GET` | 由 MemoryStore 按 id/key 精确读取。[API](worker-api/memory.zh-CN.md) |
| `MEMORY.QUERY` | 由数据库插件处理 filter、orderBy、分页 cursor/limit。[API](worker-api/memory.zh-CN.md) |
| `MEMORY.SEARCH` | 使用数据库原生检索、直接复用 Provider 或显式委托 RETRIEVAL。[API](worker-api/memory.zh-CN.md) |
| `MEMORY.WRITE` | 创建长期记录，插件分配 id 并返回完整记录。[API](worker-api/memory.zh-CN.md) |
| `MEMORY.UPDATE` | 按 id 修改已有记录；更新语义见字段说明。[API](worker-api/memory.zh-CN.md) |
| `MEMORY.DELETE` | 按 id 删除，返回实际删除列表。[API](worker-api/memory.zh-CN.md) |
| `INTERACTION.ACT.TOOL` | 执行已注册工具，校验工具名、参数与 Sandbox 权限。[API](worker-api/interaction.zh-CN.md) |
| `INTERACTION.ACT.MCP` | 用已连接客户端发现能力或调用工具；discover/invoke 输出不同。[API](worker-api/interaction.zh-CN.md) |
| `INTERACTION.OBSERVE` | 将 ExternalResult 标准化为含 tool Message 的 Observation。[API](worker-api/interaction.zh-CN.md) |
| `INTERACTION.OUTPUT` | 通过注入 OutputSink 提交交付，返回 accepted/rejected/unknown 回执。[API](worker-api/interaction.zh-CN.md) |
| `RETRIEVAL.SEARCH`（可选） | 按 target/strategy 调用检索 Provider，可组合 embedding、融合与重排。[API](worker-api/retrieval.zh-CN.md) |

缓存不同于长期 MEMORY。CONTEXT 缓存保存当前 working set；INFER 缓存保存计算结果；MEMORY 访问独立数据库。三者生命周期分别由应用及其存储插件管理。

## 常见调用链

| 需求 | 组合方式 | 关键输入输出转换 |
| --- | --- | --- |
| 第一次运行 | LOAD → SELECT | SELECT 返回 context/selectedItemIds/purpose，直接运行 [quickstart](../examples/quickstart.ts) |
| 文档问答 | LOAD → SELECT(rag) → SAMPLE → OUTPUT | 注入 ragStrategy；应用把选中条目映射为 messages，并检查 SAMPLE 的 NodeResult |
| 长期记忆问答 | MEMORY.SEARCH → UPDATE → SELECT → SAMPLE | SEARCH 返回完整 MemoryItem；检查 status 后显式映射 ContextIngress，不直接把 MemorySearchResult 当 messages |
| 多步工具任务 | ReAct：SAMPLE → TOOL/MCP invoke → OBSERVE → 下一次 SAMPLE | 将工具 schema 告诉模型，执行端注册相同工具；[流程 API](worker-api/flows.zh-CN.md) |
| 读取数据库并存回结果 | MEMORY.GET/QUERY → 应用转换 → MEMORY.WRITE/UPDATE | 数据库 SDK 执行实际操作；跨节点不是一个自动事务，幂等键/事务由插件与应用处理 |
| 候选比较或修订 | SAMPLE/TRAJECTORY → REFLECT 或 DELIBERATE | 候选为明确的公开结果；需要多个独立候选时重复调用或使用轨迹策略 |
| Skill 指令装入 | 应用读取与授权 → runSkillFlow(LOAD → 可选 UPDATE) | sources 已由应用解析；该流程不扫描磁盘、安装插件或执行脚本 |
| 工具发现与使用 | MCP discover → 应用选取 capability → MCP invoke → OBSERVE | discover 返回能力描述，不是可观察的 ExternalResult；不要直接接 OBSERVE |
| 上下文预算控制 | SELECT / COMPRESS | 默认选择或裁剪；需要模型摘要时另行调用 INFER，并按应用规则显式 UPDATE |
| 独立检索资源 | MEMORY/CONTEXT adapter → RETRIEVAL.SEARCH | 相同 Provider 可先在当前 Worker 内执行，负载需要时再注册独立检索 Worker |

SQL 和 Milvus 本身承担存储及其支持的检索；Ditto 不复制数据库。embedding 可由数据库内置，也可由外部云端/本地 Provider 生成。数据库原生检索无需强制经过 RETRIEVAL。[可运行数据库示例](worker-api/examples/integrations/README.zh-CN.md) · [检索 Provider](worker-api/retrieval-providers.zh-CN.md)。

## 执行边界

- Graph 只表达节点、依赖和输入映射；异常阻止后续任务，结构化 failed 输出需应用显式处理。
- Loop 负责状态、选图、重复和终止；不自动持久化状态或管理 session reset。
- 同进程直接调用，同机不同进程使用 IPC，跨机器使用 HTTP；Worker 配置与 SDK 保留在执行端。[部署调用](worker-api/runtime.zh-CN.md)
- Node 描述符、类型入口和 index 导出不执行业务；工厂配置实现，register 创建可调用副本。[组合 API](worker-api/composition.zh-CN.md)
