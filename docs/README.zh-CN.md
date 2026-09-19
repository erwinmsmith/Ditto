# 文档地图

[English](README.md) · **简体中文**

建议先读架构和开发指南，再按需要阅读 Worker 通信、配置和能力扩展文档。所有指南均提供英文与简体中文版本。

## 指南

| 文档 | English | 简体中文 | 内容 |
| --- | --- | --- | --- |
| 项目概览 | [Read](../README.md) | [阅读](../README.zh-CN.md) | 项目目标、能力与环境准备 |
| 架构 | [Read](architecture.md) | [阅读](architecture.zh-CN.md) | Worker 归属、内部 Node、Graph/Loop 执行、扩容与模块边界 |
| 开发与接入 | [Read](getting-started.md) | [阅读](getting-started.zh-CN.md) | 安装、检查、包入口以及自定义 Worker 和 Node |
| Worker API（已实现） | [Read](worker-api/README.md) | [阅读](worker-api/README.zh-CN.md) | INFER 七个 Node 的类型、调用、策略、流式与缓存 |
| Worker 通信 | [Read](worker-communication.md) | [阅读](worker-communication.zh-CN.md) | 本地与远程调用、HTTP 部署、生命周期、事件与 Artifact |
| 交互与运行配置 | [Read](interaction-runtime.md) | [阅读](interaction-runtime.zh-CN.md) | Provider、模型、凭证、工具、MCP、Skill 和 Sandbox 权限 |
| 节点体系与 API Contract | [Read](13-node-api-contract.md) | [阅读](13-node-api-contract.zh-CN.md) | 最终能力树、公共基础类型、25 个可执行叶子 Contract 与 Runtime 预定义流程 |
| 节点体系覆盖 | [Read](node-coverage.md) | [阅读](node-coverage.zh-CN.md) | 六个既有案例按最终节点体系重映射及验证证据边界 |

[环境变量模板](../.env.example) 使用双语注释。

## 源码索引

| 源码 | 指南 |
| --- | --- |
| `src/contracts/` | [架构](architecture.zh-CN.md)：共享数据类型与 Node 契约接口 |
| `src/worker/*/contracts.ts`、`src/worker/node.ts` | [开发与接入](getting-started.zh-CN.md)：Worker 自有契约与类型化 handler |
| `src/worker/define-worker.ts`、`src/runtime/graph.ts`、`src/runtime/router.ts` | [架构](architecture.zh-CN.md)：组合、执行与路由 |
| `src/runtime/loop.ts` | [架构](architecture.zh-CN.md#loop-执行)：状态、逐轮选图与有界执行 |
| `src/runtime/communication/`、`src/runtime/artifact.ts` | [Worker 通信](worker-communication.zh-CN.md) |
| `src/runtime/config.ts`、`src/runtime/services.ts`、`src/runtime/sandbox/` | [交互与运行配置](interaction-runtime.zh-CN.md)：配置与权限 |
| `src/worker/infer/providers/` | [交互与运行配置](interaction-runtime.zh-CN.md)：供应商中立的模型 Provider adapter |
| `src/worker/interaction/` | [交互与运行配置](interaction-runtime.zh-CN.md)：工具/MCP/Skill 叶子能力与应用 Graph + Loop 组合 |

## 双语约定

英文使用 `.md`，简体中文使用 `.zh-CN.md`。每篇文档顶部提供对应语言的链接。修改时同步两种语言，保持章节、API 定义与示例一致。导航仅收录面向使用者的文档。
