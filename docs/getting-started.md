# Ditto 开发与接入指南

Ditto 是面向 Agent 系统的轻量 TypeScript Node-native Runtime。Node 表达语义能力，Worker 承载实现与资源，Graph 描述逻辑组合，Runtime 负责执行、路由和通信。

当前是 framework initialization：单包、零第三方运行时依赖，`private: true`，尚未发布 npm。固定 Node API 版本为 `1.0`。

## 快速开始

要求 Node.js 24+、npm 11+。仓库使用 TypeScript 7 和严格类型检查。

```bash
npm ci
npm run check
```

```ts
import { createDitto, defineNode, defineWorker, graph } from "@ditto/core";

const reasoning = defineWorker({
  type: "REASONING",
  nodes: {
    "REASONING.INFER": defineNode("REASONING.INFER", async (input) => ({
      role: "assistant",
      content: `received ${input.messages.length} messages`,
    })),
  },
});

const agent = graph<string>("example")
  .node("infer", "REASONING.INFER", [], (text) => ({
    messages: [{ role: "user", content: text }],
  }));

const ditto = createDitto({ workers: [reasoning] });
const result = await ditto.run(agent, "Hello");
console.log(result.infer);
```

示例 handler 只演示接入；真实模型、数据库和工具由实验仓库实现。

## 工程边界

- Node Type 使用完整语义名，如 `REASONING.INFER`。四个一级名称是内置 Worker Type / 能力命名空间。
- Worker 仅声明自己实现的 Node；Runtime 只路由到能力匹配、可用的实例。
- Worker 通过 `resources: () => ...` 创建每个实例的资源，通过独立的 `ctx.invoke` / `ctx.emit` 使用 Runtime。
- Graph 使用逻辑 ID、依赖与显式输入映射，不保存 Worker 地址或 Provider。
- Core 默认本地直调、异步事件分发。IPC/RPC/PubSub 通过可注入接口扩展。
- 原 Contract 规定的空类保留为兼容导出；新 Runtime 不依赖这些类。

[架构说明](architecture.md) 描述机制与当前限制；[架构差异分析](architecture-review-2026-09-09.md) 记录参考文档与本次取舍；[固定 Contract](13-node-api-contract.md) 保持独立。

## 扩容与替换

```ts
const replica = ditto.register(reasoning); // 新 Worker 实例
replica.setAvailable(false);             // 从后续路由中暂停
replica.setAvailable(true);
replica.unregister();                    // 移除；已开始的调用继续完成
```

同一优先级的可用副本轮询；本地直调优先，其次同设备适配器，最后远程适配器。此阶段提供实例增删与路由机制，自动扩容决策、资源队列和集群部署是后续可选能力。

更换模型或数据库只更换实现和资源。新增语义能力才扩展 Contract；新增资源或部署边界才增加 Worker。

## 实验仓库调用

在独立实验仓库的 `package.json` 中使用相邻本地检出：

```json
{
  "type": "module",
  "dependencies": {
    "@ditto/core": "file:../Ditto"
  }
}
```

先在 Ditto 中运行 `npm ci` 或 `npm run build`，再在实验仓库安装依赖。调用统一使用 `@ditto/core` 或公开子入口，不引用私有源码路径。

完整独立示例有自己的 tsconfig，并直接校验生成的声明和 ESM：

```bash
npm --prefix examples/experimental-consumer install
npm --prefix examples/experimental-consumer run check
```

Git 依赖应指向已提交的固定 commit；`prepare` 会编译源码。当前已验证本地 file 依赖，远端 Git 安装尚未验证。npm 分发入口已预留，尚未启用发布流程。

## 质量检查

`npm run check` 执行严格类型检查、Contract 一致性测试、运行时测试和干净构建。构建会清理生成的 `dist/` 与 `.test-dist/`，防止删除或重构模块后遗留旧产物。

测试覆盖原文 Contract 的完整类型映射、类型错误拒绝、Worker 能力路由、资源隔离、Graph 分支、异步事件失败、位置迁移与 Reference 往返。位置迁移测试使用序列化测试适配器，不代表生产网络传输已经实现。
