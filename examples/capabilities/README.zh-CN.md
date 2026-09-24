# 三、Agent 基础能力

[English](README.md) · [全部示例](../README.zh-CN.md)

基础能力展示可复用的单项功能；以用户能力分类，README 中说明对应 Node 与应用适配边界。

| 分类 | 文件数 |
| --- | --- |
| [3.1 请求理解与交互](understanding/README.zh-CN.md) | 6 |
| [3.2 规划与任务管理](planning/README.zh-CN.md) | 5 |
| [3.3 信息检索与搜索](retrieval/README.zh-CN.md) | 8 |
| [3.4 信息整理与分析](analysis/README.zh-CN.md) | 7 |
| [3.5 上下文能力](context/README.zh-CN.md) | 5 |
| [3.6 记忆能力](memory/README.zh-CN.md) | 4 |
| [3.7 工具和系统操作](tools/README.zh-CN.md) | 10 |
| [3.8 执行结果理解](observation/README.zh-CN.md) | 5 |
| [3.9 内容处理](content/README.zh-CN.md) | 7 |
| [3.10 文档与多模态理解](multimodal/README.zh-CN.md) | 8 |
| [3.11 数据与代码能力](data-and-code/README.zh-CN.md) | 12 |
| [3.12 验证、评估与安全能力](validation/README.zh-CN.md) | 9 |

每个分类的 README 定义文件职责和实现边界。组合方式见 [执行模式](../patterns/README.zh-CN.md)。

[公开 API 组合与 npm 消费](../../docs/worker-api/capability-composition.zh-CN.md) 说明 12 类共 86 个入口的执行链和扩展点。统一检查：`npm run check:examples:capabilities:types`；逐能力真实任务：`npm run check:examples:capabilities:package`；全场景：`npm run check:examples:capabilities:full`。
