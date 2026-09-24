# 深入 Worker：从应用数据流到内部能力

Worker 是实现和资源边界。应用通过 Node 类型调用能力，Runtime 选择可用的 Worker 副本；Worker 名称不等同于某个“财务 Agent”角色。一个角色通常组合多个 Worker，多个角色也可以共用同一类 Worker。

## 1. Worker 之间的数据流

```text
MEMORY.GET / SEARCH → 检查并映射记录 ─┐
用户消息 / Skill / 文档 ───────────────┴→ CONTEXT.LOAD / UPDATE
                                                ↓ SELECT
                                          INFER.REASONING.*
                                         ↙                 ↘
                                  动作请求                 最终内容
                                     ↓                       ↓
                           INTERACTION.ACT.*          验证 → OUTPUT
                                     ↓                       ↓
                           INTERACTION.OBSERVE          MEMORY.WRITE
                                     ↓
                              CONTEXT.UPDATE → Loop
```

映射是明确的边界：Memory content 是 unknown，ContextItem metadata 保存角色，Infer Message 支持模型内容结构，Interaction 返回动作状态。不要把不同 Worker 的同名类型未经转换直接拼接。

## 2. CONTEXT：构建当前工作集

| 节点 | 内部职责 | 可替换能力 |
| --- | --- | --- |
| LOAD | 归一化消息/引用/条目，生成或检查 ID | ReferenceResolver、stateStore |
| SELECT | 按用途、策略、条数和 token 预算选择 | selector、ragStrategy、tokenEstimator |
| UPDATE | 删除、添加、跨 Worker ingress 合并 | 缓存 CAS、operationQueue |
| COMPRESS | 按保护组与预算裁剪 | compressor、tokenEstimator |

Context 默认压缩不调用模型做语义摘要。需要摘要时显式 INFER → 校验 → UPDATE，再 COMPRESS；这样来源、预算和失败都可观察。Redis 模式使用 scope 与版本，显式 Context 模式只对传入快照计算。

从 [CONTEXT API](../worker-api/context.zh-CN.md) 依次读“数据格式”“缓存模式”“选择与压缩插件”“错误”，再看 [5 个完整上下文任务](../../examples/capabilities/context/README.zh-CN.md)。

## 3. INFER：模型操作和计算策略

INFER 对外有四个推理叶子和三个 CACHE 叶子。ProviderRegistry 负责按名称选择供应商适配器；推理执行器负责预算与取消；策略负责一次推理任务的组织。工具和业务数据库不在其默认执行路径中。

| 功能 | 需要了解的区别 |
| --- | --- |
| SAMPLE | 生成一次响应/动作，动作尚未执行 |
| TRAJECTORY | 多步推理，检查内外两层状态 |
| REFLECT | 针对已有结果的审查/修订策略 |
| DELIBERATE | 多候选评价、选择或综合 |
| CACHE | 显式推理缓存，独立于 Context/Memory |

逐种策略、预算和流式事件见 [INFER API](../worker-api/infer.zh-CN.md)；自定义模型协议见 [Provider API](../worker-api/providers.zh-CN.md)。

## 4. MEMORY：事实持久化与搜索

MEMORY Worker 验证输入，应用默认分页/查询限制，调用 Store/Search Provider，再校验并包装 NodeResult。它不自带业务数据库驱动或表结构；原子性、事务、幂等键和索引一致性由适配器落实。

GET/QUERY 与 SEARCH 的意图不同；UPDATE 是基于 id 的修改；DELETE 需要准确返回实际删除 id。外部错误包装为稳定错误码，不应把含密码的连接串泄漏给模型。

先读[数据库与算法](memory.md)，再查 [MEMORY 六个节点](../worker-api/memory.zh-CN.md)。

## 5. INTERACTION：动作、观察和交付

| 节点 | 内部组件 | 应用资源 |
| --- | --- | --- |
| ACT.TOOL | ToolRegistry | RegisteredTool 与业务 SDK |
| ACT.MCP | McpRegistry | 已连接的中立 McpClient |
| OBSERVE | 结果归一化 | 无自动重试或 Context 更新 |
| OUTPUT | 回执校验 | 应用 OutputSink |

动作失败是业务信息，基础设施异常也可能直接抛错；两条路径都要处理。工具是否需要审批不能只靠描述属性，交付是否完成也不能只看 accepted。详见 [INTERACTION API](../worker-api/interaction.zh-CN.md)。

## 6. 每个 Worker 的共同生命周期

应用创建并连接共享 SDK → 构造 Worker definition → Runtime 注册 → 处理 Graph/Loop → 停止接收新任务 → 等待在途请求结束 → Runtime.close → 关闭应用拥有的客户端。

`resources` 工厂可为每个副本创建独立资源；`dispose` 释放副本资源。把同一个客户端传给多个 definition 会共享它，不要在第一个副本关闭时误关其他副本仍在使用的连接。

下一步：[可选 RETRIEVAL](retrieval.md) 或 [添加自己的 Worker/Node](extensions.md)。
