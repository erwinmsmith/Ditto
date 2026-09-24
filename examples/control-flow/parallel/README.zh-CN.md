# 2.3 并行与汇总

[English](README.md) · [上一级](../README.zh-CN.md) · [全部示例](../../README.zh-CN.md)

使用公开 Graph、Runtime、INFER 和 INTERACTION API，将多份订单文件处理成独立订单产物和汇总报告。文件工具位于[应用工具目录](../../_shared/tools/order-files.ts)，不增加 Core 的节点、业务逻辑或第三方依赖。

## 四类流程

| 文件 / 入口 | 任务与交付 |
| --- | --- |
| [concurrency-limit.ts](concurrency-limit.ts) / `runParallel` | 将独立文件的读取 → 模型提取 → 保存节点放入同一张 Graph，同时处理多份订单；每份订单产生独立 JSON |
| [planning.ts](planning.ts) / `runPlanning` | 模型根据目标和来源目录生成任务及依赖；校验并保存计划，使用模型生成的任务 ID 构图并执行，最后交付报告 |
| [fan-out-fan-in.ts](fan-out-fan-in.ts) / `runSummary` | 汇总节点显式依赖所有保存节点，重新读取订单产物计算总数量和总金额，再交付统一报告 |
| [partial-results.ts](partial-results.ts) / `runPartial` | 每份文件运行独立 Graph，通过 `Promise.allSettled` 保留成功产物和失败详情，统一交付 completed / partial / failed 报告 |

四个模块导入时不执行任务。[shared.ts](shared.ts) 提供本组示例的数据校验及单份订单 Graph；[cli.ts](cli.ts) 仅负责命令行配置与资源初始化。

## 运行

要求 Node.js 24+、npm 11+。从仓库根目录执行 `npm ci`，按[配置 API](../../../docs/worker-api/configuration.zh-CN.md)准备 `.env` 中的 Provider、模型、凭据和网络白名单。示例显式读取 `ditto.yaml` 和 `.env`，调用实际 HTTP 模型；订单工具仅依赖 Node.js 标准库。

```bash
npm run example:parallel:execution -- --concurrency 2
npm run example:parallel:planning -- --concurrency 3
npm run example:parallel:summary -- --concurrency 3
npm run example:parallel:partial
```

默认在 `.examples-parallel-tasks/cli-*/input/` 创建真实订单文件，并在 `output/<batchId>/` 保存任务产物。部分结果示例包含一个缺失文件，用于展示真实读取失败及成功结果保留。

处理自己的文件时，创建 manifest，路径相对 manifest 所在目录；工具限制读取该目录内的文件：

```json
{
  "sources": [
    { "id": "north", "path": "north.txt", "description": "独立的北区订单" },
    { "id": "south", "path": "south.txt", "description": "独立的南区订单" }
  ]
}
```

文件内容例如 `Order code ORDER-731; quantity 3; unit price 1250 cents.`，包含订单编号、正整数数量和非负整数单价（分）。

```bash
npm run example:parallel:summary -- --manifest /absolute/path/orders/manifest.json --concurrency 2
```

## 输入与结果

`BatchInput` 包含 `id`、`sources: { id, path, description }[]` 和 `model`。每批最多八份来源，ID 必须唯一，路径和描述不能为空。金额与数量运算必须在安全整数范围内。`runPlanning` 另需非空 `objective`，且至少有一份来源。

`runParallel` 返回 `{ orders, output }`，以输入顺序保留已保存的订单，不生成汇总报告。`runSummary` 返回 `{ report, receipt, output }`；`runPlanning` 另返回 `plan` 和规划阶段结果；`runPartial` 返回 `{ orders, failures, report, receipt }`。

报告包含：

- `status`：completed、partial 或 failed；空批次为 completed，零条成功且存在失败任务时为 failed。
- `successes`：订单来源、文件 SHA-256、编号、数量、单价和计算金额。
- `failures`：失败来源 ID、错误码和具体说明；失败记录不进入总数量与总金额。
- `totals`：成功订单数、总数量、总金额（分）。

OutputSink 的 accepted 表示报告交付成功，不把 partial / failed 的业务结果改为成功。

## 并行、规划与失败语义

`runParallel` 默认 Graph 并发上限 2；`runSummary` 和规划后的执行图默认 3。`{ concurrency, signal }` 传入公开 `runtime.run`。上限针对**当前 Graph 中活动的节点**，不是全局任务上限，也不是一个 Worker 的容量；Worker 仍需支持对应并发。

计划使用有限的业务操作：每个来源一个 extract 任务，加一个依赖所有提取结果的 summary 任务。输入目录中的文件互不依赖，提取任务应为空依赖。应用拒绝未知操作、虚构/遗漏/重复来源、重复任务 ID、无效或循环依赖，以及提前汇总。校验不会默默改写模型计划，也不执行模型提供的命令或文件路径。

Graph 遇到抛出的异常时停止调度未启动节点，等待已启动节点结束后拒绝；业务失败对象仍是数据，示例显式检查它们。普通并行和汇总沿用此语义，不把失败改成成功。

部分结果流程以独立 `runtime.run(orderGraph, ...)` 隔离每份来源，再使用标准 `Promise.allSettled` 等待所有已启动任务。最多同时发出八个分支，每个分支内部顺序执行；不提供全局并发调度器，CLI 因而不接受 `--concurrency`。取消会等待已启动任务结束再抛出，不生成正常的部分成功报告，也不回滚已保存的订单。

## 文件产物与幂等

每批保存到应用配置的输出根目录：

```text
<batchId>/
├── plan.json                 # 自动规划流程
├── <sourceId>.order.json     # 每份成功订单
├── report.json              # 汇总/部分结果流程
└── delivery.json            # OutputSink 接受后的交付记录
```

文件使用临时写入与原子发布，相同内容重试可重复执行，不覆盖已有不同内容。订单冲突记为 ARTIFACT_CONFLICT；源文件缺失或为空分别记为 SOURCE_NOT_FOUND / EMPTY_SOURCE；模型失败与无效输出分别记为 MODEL_FAILED / INVALID_MODEL_OUTPUT；其他基础设施异常记为 TASK_EXECUTION_FAILED。修正业务输入后使用新的 batchId，避免把新任务覆盖到历史结果。

工具配置、公开 API 和调用方法见[并行 API 用法](../../../docs/worker-api/parallel.zh-CN.md)。

## 任务级端到端实验

```bash
npm run check
npm run check:examples:parallel:tasks
npm run check:examples:parallel:tasks:package
# 可选择其他已配置的 Provider
npm run check:examples:parallel:tasks:package -- --provider deepseek
```

任务实验生成随机订单文件，使用真实文件工具和真实 HTTP 模型，执行 13 个用例：

- 并发上限 1 / 2：读取真实 Worker 调用的起止区间，断言实际重叠执行和节点并发上限；不靠人为延时制造并行证据。
- 汇总等待：断言汇总开始时间晚于所有分支保存结束，重新读取订单和交付文件，独立计算预期数量与金额。
- 两份 / 四份来源的自动规划：检查模型提出的来源、依赖和 ID，确认实际 Graph 使用这些 ID，并保存可检查的计划。
- 缺失文件、空文件、真实模型返回无效订单、已有产物冲突：保留成功文件，单列失败原因，汇总不计入失败任务。
- 全部失败、空批次、严格 Graph 失败，以及关闭 Runtime 后重新读取所有交付产物。

package 命令在仓库外安装 npm tarball，用无 paths 别名的严格 TypeScript 配置检查公开入口和 Node 原生 TypeScript 兼容性，再执行同一套完整任务实验。它不读取包内 src、不复制凭据、不注入模型或工具替身。

输入、业务文件和交付保留在 `.examples-parallel-tasks/run-*/`。报告分别为 `.examples-parallel-tasks-live-results.json` 与 `.examples-parallel-package-live-results.json`，记录 Provider、模型、每个 Worker 调用的起止时间、Graph/节点 ID、最大活动节点/模型数、结果和产物位置。任务结果或并行断言失败均非零退出。离线回归补充取消、异常模型响应、非法计划、幂等与交付拒绝等边界。
