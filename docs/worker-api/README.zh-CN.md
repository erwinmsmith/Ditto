# Worker 使用 API

[English](README.md) · **简体中文** · [文档地图](../README.zh-CN.md)

本目录以当前代码的公开入口为准，覆盖工厂、SDK 方法、全部 Worker 节点、Provider/存储适配器、注册表、配置和生命周期。每项操作都有调用示例；完整 TypeScript 示例放在 [examples](examples/README.md)，随 `npm run typecheck` 校验。类型定义不是自动数据库驱动或自动插件加载声明。

| Worker | 详细 API | 操作与示例 |
| --- | --- | --- |
| INFER | [中文 API](infer.zh-CN.md) · [English](infer.md) | SAMPLE / TRAJECTORY / REFLECT / DELIBERATE / CACHE LOOKUP, WRITE, INVALIDATE; SDK + stream |
| MEMORY | [中文 API](memory.zh-CN.md) · [English](memory.md) | GET / QUERY / SEARCH / WRITE / UPDATE / DELETE; store / search |
| INTERACTION | [中文 API](interaction.zh-CN.md) · [English](interaction.md) | ACT.TOOL / ACT.MCP / OBSERVE / OUTPUT; ToolRegistry / McpRegistry / OutputSink |
| RETRIEVAL （可选） | [中文 API](retrieval.zh-CN.md) · [English](retrieval.md) | SEARCH; SDK / target / strategy / 独立部署 |

## 从哪里开始

1. 定义 Agent Graph：选择语义 Node、数据映射及失败时是否继续；不要把数据库连接、客户端或凭据放进 Graph。
2. 需要循环时定义 Loop：状态、更新规则、done 与 maxIterations。单轮直接 runtime.run，循环用 runtime.loop。
3. 定义 Worker 内部能力：模型 Provider、MemoryStore/search、RegisteredTool/McpClient/OutputSink。
4. 创建 Runtime 并注册 Worker；加载根目录 YAML 的行为参数和 env 的连接/凭据。
5. 只有需要独立检索资源时，显式导入并注册 RETRIEVAL；普通 MEMORY 原生检索不需要它。

完整流程见 [Graph + Loop + Worker](../../examples/graph-loop-worker.ts)；真实命令与普通工具组合见 [interaction-tools.ts](../../examples/interaction-tools.ts)。

## 返回值与错误：不要混用

| 调用层 | 返回 | 失败处理 |
| --- | --- | --- |
| INFER / MEMORY / RETRIEVAL SDK 或 Worker | `NodeResult<T>` | 检查 status 后读取 output；构造、路由或传输错误仍可能抛异常 |
| INTERACTION | `ExternalResult` / `Observation` / MCP union / `OutputReceipt` | 直接检查各自 status；参数/权限/基础设施错误抛异常 |
| 底层 store / Provider / Sink | 各自原始 Output | 由对应 Worker 包装或校验；不要再套一层 NodeResult |

INFER 轨迹还有内层 output.status，外层 success 不等于轨迹 completed。取消或超时不表示外部操作已回滚；数据库、命令、MCP 与交付的幂等/重试由应用和适配器决定。

## 插件与配置专项

- [模型 Provider：注册/注销、HTTP、供应商协议、invoke/stream](providers.zh-CN.md)
- [检索 Provider：embedding、vector/text、RRF、rerank、SQL/Milvus 和 MEMORY 双向转接](retrieval-providers.zh-CN.md)
- [统一配置：根目录 ditto.yaml / .env 的字段、分组和优先级](configuration.zh-CN.md)

INTERACTION 的工具、MCP 实例与输出函数通过代码注入；当前 YAML 不支持 workers.interaction 或任意插件名的自动加载。数据库 SDK 与模型 SDK 生命周期由应用拥有，不逐请求创建或自动关闭。

## 示例覆盖与验证范围

| 示例文件 | 覆盖 |
| --- | --- |
| [memory.ts](examples/memory.ts) | 两个工厂、六个 SDK/节点、execute、分页、插件、错误、Graph、描述符 |
| [infer.ts](examples/infer.ts) | 两个工厂、七个叶子、五种策略、三种反思、四种审议、四个流、缓存及模型 Provider |
| [interaction.ts](examples/interaction.ts) | 工厂、注册/移除、四个节点、MCP、观察、回执、handler、Graph/Loop |
| [retrieval.ts](examples/retrieval.ts) | 工厂、SEARCH、Registry、embedding、融合/重排、数据库适配和 MEMORY 转接 |

类型检查验证示例与接口一致，不等同于已经连接每个数据库或在线模型。已执行的真实验证单独记录：

- [INFER 真实验证](infer-live-report.md)
- [INTERACTION Linux/macOS + MCP 实测](interaction-live-report.md)
