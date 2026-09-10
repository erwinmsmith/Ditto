<p align="center">
  <img src="./logo.png" alt="Ditto 标志" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  面向 Agent 原生工作流的开发节点框架。<br />
  按需扩容，低成本演进 Agent 结构。
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

## 项目介绍

Ditto 是一个 agent-native 的开发节点框架，核心理念很简单：Agent 系统应该能够随着开发任务的变化而扩展和调整。

框架旨在将开发能力组织成可组合的节点，在需要时扩展处理能力，并降低更新 Agent 结构所需的改造成本。从一组精简的节点开始，随着需求演进，逐步调整系统的能力和组织方式。

## 设计目标

| 目标 | 含义 |
| --- | --- |
| **Agent 原生** | 将 Agent 作为开发工作流的一等参与者，以节点组织其开发能力。 |
| **按需扩容** | 随着工作量和任务复杂度增长，按需增加 Worker 实例。 |
| **低成本演进** | 通过局部调整 Agent 职责和节点组合，减少结构变化带来的整体改造。 |

## 节点模型

开发节点被设想为可组合的 Agent 能力单元。节点用于组织开发任务，同时让整体 Agent 结构能够持续演进。

- **从小规模开始。** 只定义当前工作流需要的节点。
- **按实际需求扩展。** 新增语义能力时增加 Node，需要更多处理容量时增加 Worker 实例。
- **逐步调整结构。** 随着工作流变化，更新节点职责和协作方式。

初始化框架明确区分语义 Node、Worker 实例、逻辑 Execution Graph 和 Runtime。容量通过 Worker 副本扩展；更换模型或数据库实现无需新增 Node Type。

## 项目状态

Ditto 已包含轻量 TypeScript 框架初始化：固定 Node Contract、声明式 Worker、能力感知路由、DAG 执行、invoke/emit 通信及 Inline/Reference 载荷。Node API 保持 v1.0。

Core 没有第三方运行时依赖，package 仍为 private，暂未发布 npm。生产 IPC/RPC、分布式部署和自动扩容控制器属于后续可选实现；当前通过测试适配器验证传输边界。

## 开发与使用

要求 Node.js 24+、npm 11+。

```bash
npm ci
npm run check
```

检查包括严格类型检查、15 个测试和干净构建。独立实验仓库示例：

```bash
npm --prefix examples/experimental-consumer ci
npm --prefix examples/experimental-consumer run check
```

- [开发与接入指南](docs/getting-started.md)
- [架构及当前边界](docs/architecture.md)
- [架构差异分析与取舍](docs/architecture-review-2026-09-09.md)
- [固定 Node API Contract](docs/13-node-api-contract.md)

## 交流与反馈

欢迎通过 [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) 分享使用场景、讨论节点模型或提出改进建议。尤其欢迎描述你的 Agent 工作流在什么情况下需要扩容或调整结构。
