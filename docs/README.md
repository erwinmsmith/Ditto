# 文档地图

仓库统一使用 `docs/` 作为文档目录。建议先读架构和开发指南，再按需要阅读通信和 Agent 扩展。

| 文档 | 内容与适用场景 | 状态 |
| --- | --- | --- |
| [根 README（英文）](../README.md) / [中文](../README.zh-CN.md) | 项目定位、能力概览、最短运行路径 | 当前入口 |
| [架构](architecture.md) | Worker 子结构、两种 Graph 执行范围、扩容与模块边界 | 当前设计 |
| [开发与接入](getting-started.md) | 安装、检查、配置、包入口与自定义 Node | 当前指南 |
| [Worker 通信](worker-communication.md) | direct / 同机跨进程 / 跨服务器、HTTP 部署、生命周期与失败语义 | 当前指南 |
| [Agent 与运行配置](interaction-runtime.md) | 多 Provider、模型与 Key、工具调用、MCP、Skill、Sandbox | 当前指南 |
| [早期重构说明](refactor-2026-09-10.md) | 早期扁平结构的背景 | 历史记录；已由 Worker 归属结构替代 |
| [Node API Contract v1.0](13-node-api-contract.md) | 原有 18 个语义 Node 的固定输入输出；历史空类不再实现 | 仍有效的契约基线 |
| [初始化架构评审](architecture-review-2026-09-09.md) | 初始化阶段的背景和取舍 | 历史记录，架构以当前文档为准 |

## 文档与代码对应

| 代码/示例 | 阅读位置 |
| --- | --- |
| `src/contracts/` | 共享数据类型和通用类型协议，见架构中的 contracts 边界 |
| `src/worker/*/contracts.ts`、`src/worker/node.ts` | 各 Worker 的 Node 契约、共享 handler 类型；见开发与接入 |
| `src/worker/define-worker.ts`、`src/runtime/graph.ts`、`router.ts` | 架构、Worker 通信 |
| `src/runtime/config.ts`、`services.ts`、`src/worker/reasoning/providers/`、`src/runtime/sandbox/` | Agent 与运行配置 |
| `src/runtime/communication/`、`src/runtime/artifact.ts` | Worker 通信 |
| `src/worker/interaction/` | Agent 与运行配置；`INTERACTION.*` 是单独的 Node 扩展，不改写 v1.0 契约 |
| `examples/`（当前留空） | 后续基于 npm 包的 Agent 示例 |
| [.env.example](../.env.example) | 环境变量完整示例 |

修改公共行为时同步对应指南；修改 v1.0 输入输出时遵循契约版本规则。历史决策文档保留时间背景，不用来覆盖当前实现。
