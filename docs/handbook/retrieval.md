# 可选 RETRIEVAL：安装、接线与 RAG

主包可以独立运行。只有需要检索 Provider、检索适配器或独立搜索 Worker 时，额外安装 `@codesoul-co/ditto-retrieval`。Context 的基本选择与 Memory 的原生搜索不要求这个包。

## 1. 安装与入口

```sh
npm install @codesoul-co/ditto @codesoul-co/ditto-retrieval
```

| 入口 | 内容 |
| --- | --- |
| `@codesoul-co/ditto-retrieval` | Worker、SEARCH 契约、TargetRegistry、text/vector/hybrid/rerank/embedding/数据库适配 |
| `/adapters/memory` | Memory → retrieval、retrieval → Memory 的适配 |
| `/adapters/context` | Context RAG 策略适配 |

检索包以 peer dependency 复用主包。导入会补充 TypeScript NodeContractMap，但仍需注册 Worker。不要再从主包的 `/worker/retrieval` 或包内 src/dist 导入。

## 2. 第一次检索

```sh
node examples/package-basics/retrieval.ts Redis
```

<<< ../../examples/package-basics/retrieval.ts

这里的两条文档是应用内的演示资料，关键词过滤用于说明接线，不声称是数据库或向量索引。成功时返回命中项与 `guide.md#context` 来源；无匹配时返回空候选。

## 3. target 与 strategy

TargetRegistry 将允许访问的 target 绑定到 provider 与默认 strategy。应用根据已认证身份决定 target/namespace，不能让模型任意指定生产索引或其他租户的数据域。

| strategy | 工作方式 | 依赖 |
| --- | --- | --- |
| text/keyword | 文本查询 → 搜索后端 | 数据库全文搜索、搜索引擎或应用实现 |
| vector | 查询向量或 embedding → 向量召回 | embedding 模型、维度一致的索引 |
| hybrid | 多路召回 → 融合 | 多 Provider、稳定候选标识、RRF 等融合 |
| rerank | 初始候选 → 重排 | 重排模型或应用排序器 |

策略名称由 Registry 配置，不是任何任意字符串都自动有效。查询/文档 embedding、数据库连接及底层 SDK 的生命周期仍由应用持有。

## 4. 与 Memory 的两种组合

**内部长期知识**：已审核资料在 Memory 事实库中，原生 MEMORY.SEARCH 直接可用；需要独立计算时通过 `RemoteRetrievalSearchProvider` 委托 RETRIEVAL，返回前映射为完整 MemoryItem。

**外部知识库**：通过检索 Provider 访问企业知识库、文档搜索服务或向量索引。外部候选不能无条件当作长期 Memory，也不能与用户私有会话记录混用权限。

检索服务返回的 id、content、source、score 要与后续 Context 显式映射。来源 ref 与 Context 的 Reference.uri 不是同一个字段，适配器负责转换。不要将评分直接宣称为事实可信度。

## 5. 从搜索到 RAG 的完整 Graph

```text
用户请求与身份
  → 问题理解 / 查询构造
  → RETRIEVAL.SEARCH
  → 候选过滤（租户、版本、来源、去重）
  → CONTEXT.LOAD / UPDATE
  → CONTEXT.SELECT（预算）
  → INFER.REASONING.SAMPLE
  → 来源引用核验
  → MEMORY 检查点 / INTERACTION.OUTPUT
```

简单问题可以放在一张 Graph；需要重新检索、人工确认、恢复或多阶段业务时，用 Loop 选择下一张阶段 Graph。检索空结果时返回缺失信息或继续检索，不让模型凭空编造来源。

[4.1 RAG 完整应用](../../examples/patterns/rag-qa/README.zh-CN.md)包含请求结构、资料接入、查询、来源定位、Redis/Memory、答案与引用核验，以及实际输出文件。

## 6. 数据库与部署

[检索 Provider 参考](../worker-api/retrieval-providers.zh-CN.md)逐项介绍 HTTP embedding、SQL、Milvus、向量、RRF、rerank 与 Memory/Context 转接。数据库可直接在当前进程中使用，也可让 RETRIEVAL Worker 独立进程/远端部署，应用 Graph 的 Node 类型不变。

多进程部署需要应用配置认证后的传输、资源地址与 Worker 能力注册。不能只安装包就期待搜索服务、索引、embedding 端点自动存在。

## 7. 验收

验证空查询、空结果、未知 target、非法策略、向量维度错误和后端失败；核对候选来源、租户过滤、取消传递及超时。对完整 RAG 还要验证答案中的每条引用确实来自所选资料，并在来源不足时明确表达限制。

[RETRIEVAL 完整 API](../worker-api/retrieval.zh-CN.md) · [多来源检索示例](../../examples/capabilities/retrieval/README.zh-CN.md)
