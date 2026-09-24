# Ditto 开发者指南

Ditto 将 Agent 的一次操作定义为 **Node**，将实现、连接和计算资源放入 **Worker**，使用 **Graph** 声明步骤依赖，再用 **Loop** 控制阶段、分支、循环和恢复。应用可以替换模型、工具、数据库或部署位置，保留相同的 Graph。

本指南面向使用 npm 包的开发者。所有框架调用来自 `@codesoul-co/ditto` 的公开入口；可选检索能力来自独立的 `@codesoul-co/ditto-retrieval`。示例中的业务控制器、第三方 SDK 和数据库适配器属于应用。

## 按你的任务开始

| 你要完成的事情 | 阅读顺序 | 完成后获得 |
| --- | --- | --- |
| 第一次运行 | [安装](../package-guide.zh-CN.md) → [项目结构](agent.md) | 一个可执行 Graph，以及带 Redis/SQLite 的完整会话 Agent |
| 给已有模型接工具 | [模型](models.md) → [Tool](tools.md) → [Graph/Loop](graph-loop.md) | 模型提出动作、工具执行、观察、再判断的闭环 |
| 接入外部 MCP | [MCP](mcp.md) → [INTERACTION](../worker-api/interaction.zh-CN.md) | 实际建立连接、发现工具、调用和关闭客户端 |
| 使用技能与工作上下文 | [Skill](skills.md) → [CONTEXT](../worker-api/context.zh-CN.md) | 可信技能目录、加载权限、上下文选择与预算 |
| 长期记忆与数据库 | [Memory 算法](memory.md) → [MEMORY API](../worker-api/memory.zh-CN.md) | 数据库配置、写入/更新/检索、相关性算法和恢复边界 |
| 做文档问答 | [可选检索包](retrieval.md) → [RAG 示例](../../examples/patterns/rag-qa/README.zh-CN.md) | 请求 → 检索 → Context → 生成 → 引用 → 持久交付 |
| 增加框架能力 | [扩展 Worker/Node](extensions.md) → [部署](deployment.md) | 类型契约、handler、资源、注册、私有节点与路由 |

## 建议的阅读路线

1. **先运行**：安装主包，完成无外部依赖的 Context Graph；确认 Node 版本、ESM 和导入方式正确。
2. **再连接资源**：配置模型、Redis、文件 SQLite；从真实请求执行到答案文件，不停留在模型返回文本。
3. **理解编排**：一个阶段使用一个 Graph，跨阶段和子计划由一次 Loop 调度；明确失败、超时和预算。
4. **逐个深入 Worker**：学习其节点、输入输出、默认行为、可替换服务和错误处理。只安装当前需要的适配器。
5. **扩展应用**：将第三方 SDK 包装为 Provider/Tool/Store；只有出现新语义操作时才新增 Node。

## 包的边界

| 层 | 负责什么 | 不会自动发生的事情 |
| --- | --- | --- |
| Runtime | 注册、路由、执行、取消和部署通信 | 不自动读取用户身份或建立所有数据库连接 |
| Graph | 节点依赖、输入绑定、并发可执行关系 | 不负责执行过程中动态新增步骤 |
| Loop | Graph 的选择、重复、停止和阶段切换 | 不自动持久化生成器栈或任务检查点 |
| Worker | 具体节点与副本资源 | 不根据文件夹名称自动加载插件 |
| 应用 | 认证、资源连接、业务状态、策略和交付 | 需要明确配置并验证实际业务效果 |

## 文档与示例怎么对应

本手册讲“如何搭建”；[Worker API](../worker-api/README.zh-CN.md) 给出逐方法参数、返回值、默认值和完整调用；[示例库](examples.md) 提供从真实输入到产物的完整应用。代码页可直接阅读，示例包可下载后安装 npm 依赖运行。

中英文既有 API 与示例都保留。需要英文参考时从 [English guide](../package-guide.md) 开始；中文搭建手册与两种语言的 API 使用同一套公开契约。
