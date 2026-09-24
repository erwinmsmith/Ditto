# Type-checked Worker API examples / 可类型检查的 API 示例

The learning catalog is organized in [examples/](../../../examples/README.md). Runnable API examples include: [setup guide](guide.md), [Runtime](runtime/README.md), and [database integrations](integrations/README.md). `graph-loop-worker.ts`, `runtime/graph-loop.ts`, and `runtime/placement.ts` run at module load; the import-safe description below applies to the per-API function examples in the table.

三层学习目录见 [examples/](../../../examples/README.zh-CN.md)。完整 API 示例参见[接入指南](guide.zh-CN.md)、[Runtime](runtime/README.zh-CN.md) 和[数据库接入](integrations/README.zh-CN.md)。上述三个入口在导入时执行，下文“导入不执行”的说明针对表格中的逐 API 函数示例。

These files accompany the bilingual API references. They export example functions and do not execute requests when imported. Supply application-owned model/database/MCP adapters, then call only the example needed. Model calls can consume provider credits; database write/update/delete examples perform the named operation.

这些文件与中英文 API 文档对应。导入不执行请求；参数中的数据库、模型和 MCP 适配器由应用提供。按需调用某个示例函数即可。函数名后的返回值由 TypeScript 推导，完整参数和语义见对应 API 文档。

| File | Reference | Setup |
| --- | --- | --- |
| [context.ts](context.ts) | [CONTEXT](../context.zh-CN.md) | Explicit Context, injected Redis or ContextStateStore; no requests on import. |
| [memory.ts](memory.ts) | [MEMORY](../memory.zh-CN.md) | Supply MemoryResources; filters/cursors/orderBy belong to the plugin. |
| [infer.ts](infer.ts) | [INFER](../infer.zh-CN.md) · [Providers](../providers.zh-CN.md) | Supply InferClient/ModelConfig, or load root config in setupInfer. |
| [interaction.ts](interaction.ts) | [INTERACTION](../interaction.zh-CN.md) | File examples need workspace access; MCP examples need a connected client and an allowed absolute file path. |
| [retrieval.ts](retrieval.ts) | [RETRIEVAL](../retrieval.zh-CN.md) · [Providers](../retrieval-providers.zh-CN.md) | Supply search/embedding/rerank backends; Memory bridge examples require complete MemoryItem candidates unless mapOutput is supplied. |

Run from the repository root:

```bash
npm run typecheck
```

`tsconfig.json` includes these files; build/test emit configurations keep them out of the distributed package. These are API usage examples, not new SDK implementations or automatic live integration tests. The shared imports and each `// example:` region are reproduced in the corresponding API reference. Keep both copies aligned when changing signatures.

For a complete executable local flow use `npm run example:agent` or `npm run example:tools`. MCP setup and commands are in the [example guide](guide.md#mcp). `.env` loading is explicit: use Node `--env-file=.env` or your application's loader before a function that reads process.env. `loadRuntimeConfigFile` loads YAML and consumes the supplied environment; it does not read `.env` itself.

## 每个示例具体做什么 / Function guide

下面按文件列出每个导出函数或示例对象。对象和构造函数不会自动运行 Graph；需要接入后再执行。文件中的数据库适配、模型及 MCP Client 参数，均指应用提供的已配置资源。

### memory.ts

| 函数 / 对象 | 用途与实际行为 |
| --- | --- |
| [`setupMemory`](memory.ts#L8) | 加载配置，同时创建 MEMORY Worker/Runtime 与直接 SDK；两者使用应用提供的存储与检索资源。 |
| [`getMemory`](memory.ts#L17) | 按 ID 和 key 精确读取，展示重复 ID 去重与 NodeResult 成功检查。 |
| [`queryMemory`](memory.ts#L25) | 按 id 排序读取最多两页，传递 nextCursor 并合并 items；插件须支持示例排序字段。 |
| [`searchMemory`](memory.ts#L39) | 使用数据库插件的默认检索策略，读取完整记忆及可选 score。 |
| [`writeMemory`](memory.ts#L47) | 写入一条语言偏好，返回数据库分配的 id；重复 key 的行为由插件决定。 |
| [`updateMemory`](memory.ts#L55) | 按已有 id 替换内容并清空 metadata，展示 partial update 的字段语义。 |
| [`deleteMemory`](memory.ts#L63) | 删除指定 id，查看实际删除列表；重复 id 不会重复报告。 |
| [`executeMemory`](memory.ts#L71) | 用统一 execute 入口调用 MEMORY.QUERY。 |
| [`adaptDatabase`](memory.ts#L77) | 将已符合 Memory 契约的应用数据库适配器包装为 store/search，保留方法的 this 绑定。 |
| [`memoryErrors`](memory.ts#L92) | 演示非法 limit 与应用 MemoryError 如何返回结构化失败。 |
| [`memoryGraph`](memory.ts#L106) | 将 MEMORY.GET 放入 Graph，通过 Runtime 执行后关闭。 |
| [`customGet`](memory.ts#L115) | 通过节点描述符定义一个显式 NOT_CONFIGURED 失败处理器；展示 define 用法，不读数据库。 |

### infer.ts

| 函数 / 对象 | 用途与实际行为 |
| --- | --- |
| [`setupInfer`](infer.ts#L11) | 加载 YAML/env 配置，创建共享缓存的 Worker、Runtime 与直接 SDK。 |
| [`sample`](infer.ts#L20) | 单次模型采样，读取 Message、finishReason 和 usage。 |
| [`sampleActions`](infer.ts#L30) | 向模型声明 read_text 动作；只生成动作请求，不实际执行文件读取。 |
| [`trajectory`](infer.ts#L39) | 执行 CoT 轨迹，同时检查外层 success 与内层 completed。 |
| [`strategyRequests`](infer.ts#L52) | 只构造 CoT、Long CoT、ToT、GoT、Self-consistency 五种请求，不调用模型。 |
| [`reflectModes`](infer.ts#L64) | 根据传入的 critique/verify/revise 模式评估或修正候选答案。 |
| [`deliberateModes`](infer.ts#L76) | 根据 select/merge/consensus/debate 模式处理候选；只有 select 设置 selectCount。 |
| [`cacheApis`](infer.ts#L90) | 演示缓存写入、命中读取，以及按 key/tag/namespace 失效。 |
| [`executeInfer`](infer.ts#L102) | 通过统一 execute 入口采样，并设置单次调用 timeoutMs。 |
| [`streamApis`](infer.ts#L107) | 依次消费四类 reasoning 流，展示各自终态输出；运行该函数会发起多次模型调用。 |
| [`cancelInfer`](infer.ts#L129) | 传入预先取消的 AbortSignal，演示不发起模型请求的 cancelled 返回。 |
| [`cacheProviderApi`](infer.ts#L136) | 直接调用缓存后端的 write/lookup/invalidate；返回原始输出，不套 NodeResult。 |
| [`refineStrategy`](infer.ts#L145) | 自定义策略函数：生成初稿、修订、审议选择，再记录公开决策步骤；注入后才能按名称使用。 |
| [`providerRegistryApis`](infer.ts#L159) | 注册模型 Provider、按名称解析、调用原始 invoke，并在结束时注销。 |
| [`providerStream`](infer.ts#L169) | 直接消费 Provider 流；不支持 stream 时回退到 invoke。 |
| [`httpModelProvider`](infer.ts#L180) | 按传入配置创建 HTTP 模型适配器；构造本身不发请求。 |
| [`sampleDescriptor`](infer.ts#L188) | 将现有 SDK 的 sample 方法包装为一个 NodeDefinition，不自动注册或执行。 |

### interaction.ts

| 函数 / 对象 | 用途与实际行为 |
| --- | --- |
| [`readTextTool`](interaction.ts#L9) | 定义读取工作区文件的工具，包括参数校验、能力描述和 Sandbox 文件读取。 |
| [`consoleSink`](interaction.ts#L22) | 定义控制台输出接收端，打印消息并返回 accepted 回执。 |
| [`setupInteraction`](interaction.ts#L30) | 将文件工具、已连接 MCP 客户端和输出接收端注册进同一个 Worker/Runtime。 |
| [`interactionNodes`](interaction.ts#L38) | 使用注册表、createInteractionNodes 与 defineWorker 组装 Worker。 |
| [`interactionHandlers`](interaction.ts#L45) | 分别用各 handler 工厂组装四个 Interaction 节点。 |
| [`toolRegistryApis`](interaction.ts#L57) | 在真实 WorkerContext 中注册工具、列出允许的定义、调用工具并注销。 |
| [`invokeTool`](interaction.ts#L68) | 通过 Runtime 真实读取 README.md，展示 ExternalResult 不含 output 包装。 |
| [`mcpRegistryApis`](interaction.ts#L78) | 直接使用 McpRegistry 发现工具、调用 read_text_file，并注销客户端绑定。 |
| [`invokeMcp`](interaction.ts#L90) | 通过 Runtime 调用 MCP 发现与文件读取，区分两种响应形状。 |
| [`observeApis`](interaction.ts#L104) | 对比纯函数与 OBSERVE 节点的标准化结果；使用本地给定结果，不调用外部服务。 |
| [`outputApi`](interaction.ts#L115) | 向控制台接收端提交结构化消息与 artifact 引用，返回交付回执；不创建 artifact 文件。 |
| [`missingRecordTool`](interaction.ts#L126) | 定义返回 NOT_FOUND 的示例工具，用于说明业务失败结果。 |
| [`rejectedSink`](interaction.ts#L130) | 定义返回 rejected 的接收端，用于说明交付失败回执。 |
| [`interactionGraph`](interaction.ts#L135) | 通过 Graph + Loop 读取 README.md 和 package.json，并输出两次观察结果。 |
| [`observationDefinition`](interaction.ts#L154) | 用节点描述符定义 OBSERVE handler，不自动注册或执行。 |
| [`mcpClientAdapter`](interaction.ts#L157) | 包装中立 MCP 客户端，保留方法的 this 绑定和可选响应字段。 |

### retrieval.ts

| 函数 / 对象 | 用途与实际行为 |
| --- | --- |
| [`request`](retrieval.ts#L16) | 公共示例请求：查询 agent memory、逻辑目标 kb、limit=5；只是数据。 |
| [`setupRetrieval`](retrieval.ts#L19) | 显式注册可选 Worker 与逻辑 target/strategy，并创建直接检索 SDK。 |
| [`retrievalSearch`](retrieval.ts#L28) | 用同一个后端分别执行 SDK 和 Runtime 检索，展示候选输出。 |
| [`registryResolve`](retrieval.ts#L39) | 按目标选择默认策略 Provider，直接读取原始结果。 |
| [`cancelRetrieval`](retrieval.ts#L46) | 演示 search 第三个参数中的 AbortSignal，以及第二个参数的后备默认值。 |
| [`embeddingApis`](retrieval.ts#L54) | 比较直接 embed 与分批 embedContents，并用 validateVector 检查维度。 |
| [`httpEmbedding`](retrieval.ts#L62) | 从 env 创建真实 HTTP embedding Provider，使用 YAML 批次配置生成查询向量。 |
| [`externalVector`](retrieval.ts#L72) | 先调用外部 embedding，再将向量交给数据库后端检索。 |
| [`nativeVector`](retrieval.ts#L76) | 将原始查询交给具备内置 embedding 的数据库后端。 |
| [`precomputedVector`](retrieval.ts#L79) | 直接使用已有向量检索，并校验向量维度。 |
| [`textSearch`](retrieval.ts#L84) | 包装数据库的原生文本检索，不进行 embedding。 |
| [`hybridSearch`](retrieval.ts#L89) | 并行调用 vector 与 keyword 分支，再通过加权 RRF 融合候选。 |
| [`rerankApis`](retrieval.ts#L97) | 使用 embedding 创建 cosine 重排器，对比原始 index/score 与映射后的候选结果。 |
| [`rerankSearch`](retrieval.ts#L104) | 扩大召回池后使用注入的 reranker 重排，截取请求数量。 |
| [`sqlSearch`](retrieval.ts#L110) | 创建使用 PostgreSQL 全文 SQL 的检索适配器；注入 query 回调，绑定文本和租户参数。 |
| [`milvusSearch`](retrieval.ts#L128) | 创建 Milvus 请求/响应适配器；注入 SDK search，映射 namespace 与完整 MemoryItem。 |
| [`nativeMemoryInRetrieval`](retrieval.ts#L140) | 把数据库原生 MemorySearchProvider 转成 Retrieval Provider，再映射回 Memory 结果。 |
| [`nativeMemoryWithNamespace`](retrieval.ts#L147) | 将 Retrieval namespace 显式转换为插件的 tenant filter；不替代鉴权。 |
| [`localMemoryPipeline`](retrieval.ts#L160) | 在 MEMORY 内直接复用检索 pipeline，不启动 RETRIEVAL Worker。 |
| [`delegatedMemory`](retrieval.ts#L168) | 将 MEMORY.SEARCH 委托给 Runtime 中的 RETRIEVAL.SEARCH；示例采用同进程路由。 |
| [`mapTextCandidates`](retrieval.ts#L180) | 把候选中的完整业务内容映射为 MemoryItem；片段/ID 索引需要改成批量补全。 |
| [`retrievalDescriptor`](retrieval.ts#L188) | 将检索 SDK 包装为单个 NodeDefinition，保留 SDK 校验与 NodeResult。 |

## 先运行哪个 / Suggested order

1. 不准备外部依赖时，先运行[根目录完整示例](guide.zh-CN.md)。
2. 学习某个 Worker 时，在上表选择对应函数，按文件签名注入资源。`setupMemory` / `setupInfer` / `setupInteraction` / `setupRetrieval` 返回的 Runtime 由调用者关闭。
3. 修改示例后，在项目根目录运行 `npm run typecheck`。仅运行 `node docs/worker-api/examples/memory.ts` 这类命令不会执行其中的示例函数。

### context.ts

| 函数 / 对象 | 用途与实际行为 |
| --- | --- |
| [`setupContext`](context.ts) | 创建 SDK 与 Worker；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`loadContext`](context.ts) | LOAD：消息、条目与引用；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`selectContext`](context.ts) | SELECT：推理与记忆用途；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`updateContext`](context.ts) | UPDATE：增量与来源；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`compressContext`](context.ts) | COMPRESS：预算；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`executeContext`](context.ts) | execute：通用调用；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`cachedContext`](context.ts) | 四个节点的缓存调用；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`redisStore`](context.ts) | Redis 存储与显式版本；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextServices`](context.ts) | 注入自定义服务；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`ragContext`](context.ts) | RAG 策略；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextRetrieval`](context.ts) | 复用 RETRIEVAL Provider；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextToInfer`](context.ts) | 传入 INFER；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`memoryToContext`](context.ts) | MEMORY 与 Context Graph；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextFlows`](context.ts) | RAG 与 Skill 流程；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextErrors`](context.ts) | 错误分支；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`directStrategies`](context.ts) | 复用内置策略；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`customContextLoad`](context.ts) | 自定义节点描述符；详见 [CONTEXT](../context.zh-CN.md)。 |
| [`contextToMemory`](context.ts) | 写入长期 MEMORY。 |
| [`toolToCachedContext`](context.ts) | 工具观察写入缓存。 |
| [`remoteContextRetrieval`](context.ts) | 委托独立 RETRIEVAL。 |

真实数据库接入的完整入口见 [examples/worker](integrations/README.zh-CN.md)：CONTEXT + Redis、MEMORY + SQL / Milvus；本目录保留逐 API 函数示例。

Runtime 公共接口的完整可运行示例见 [examples/runtime](runtime/README.zh-CN.md)：quickstart.ts（第一次 Graph 执行）、api.ts（自定义 Worker、事件、Artifact 与关闭）、flows.ts（RAG/Skill/Tool/MCP/ReAct）。这些文件导入时不执行请求；各导出函数的用途在子目录 README 中列出。
