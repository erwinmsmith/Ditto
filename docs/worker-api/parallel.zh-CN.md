# 并行与汇总：公开 API 用法

[English](parallel.md) · [Runtime](runtime.zh-CN.md) · [四类示例](../../examples/control-flow/parallel/README.zh-CN.md)

并行流程使用现有 Graph 依赖、`runtime.run(plan, input, options)` 和应用侧工具组合。互不依赖的节点可以同时运行；汇总节点将所有保存节点列为依赖。模型规划、订单工具和部分结果处理属于应用示例，不增加 Core 的公共节点或调度接口。

## 调用示例

安装 `@codesoul-co/ditto` 所需版本，复制 `examples/control-flow/parallel/` 和 `examples/_shared/tools/order-files.ts`，保留相对路径。准备 `ditto.yaml`、`.env` 及实际订单文件，然后在应用根目录调用：

```ts
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createOrderFiles } from "./examples/_shared/tools/order-files.ts";
import { runSummary } from "./examples/control-flow/parallel/fan-out-fan-in.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const files = createOrderFiles({ inputDirectory: resolve("orders"), outputDirectory: resolve("reports") });
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: files.tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools: files.tools, output: files.output })],
});
try {
  const result = await runSummary(runtime, {
    id: "orders-today", model: config.model,
    sources: [
      { id: "north", path: resolve("orders/north.txt"), description: "Independent north order" },
      { id: "south", path: resolve("orders/south.txt"), description: "Independent south order" },
    ],
  }, { concurrency: 2 });
  console.log(result.report, result.receipt.artifacts);
} finally { await runtime.close(); }
```

Node.js 24+ 使用 `node --env-file=.env app.ts`。TypeScript 使用 NodeNext 解析，无需源码 paths 别名。工具配置留在应用代码；展开 `config.sandbox` 保留 Provider 已配置的网络权限。`runSummary` 等函数是复制到应用的示例入口，不是 `@codesoul-co/ditto` 包导出。

## 四个应用入口

| 入口 | 参数与返回 |
| --- | --- |
| `runParallel(runtime, input, options?)` | input 为 BatchInput；options 为 `{ concurrency?, signal? }`，默认并发 2；返回按来源顺序排列的 `{ orders, output }` |
| `runSummary(runtime, input, options?)` | 默认并发 3；所有保存节点完成后汇总并交付，返回 `{ report, receipt, output }` |
| `runPlanning(runtime, { ...input, objective }, options?)` | 模型提出并持久保存计划；验证后按模型任务 ID 构图执行；默认执行并发 3；返回 `{ plan, planning, report, receipt, output }` |
| `runPartial(runtime, input, { signal }?)` | 最多八个独立 Graph，标准 Promise.allSettled 收集成功与失败；返回 `{ orders, failures, report, receipt }` |

runtime 参数为 `Pick<DittoRuntime, "run">`。调用方注册 Worker 并拥有 Runtime 生命周期。BatchInput 为 `{ id, sources: { id, path, description }[], model }`。动态来源 ID 使用运行时键的输出 Map；Graph builder 仍校验重复节点和不存在的依赖。固定 Graph 中声明的依赖继续由公开类型检查。

## 编排语义

`graph<I>(id).node(id, node, dependencies, bind)` 创建静态 DAG。空依赖的独立读取可以同时开始，每份文件的 SAMPLE 依赖自己的读取，保存节点依赖读取和 SAMPLE，汇总依赖所有保存节点。

`runtime.run(..., { concurrency: 2 })` 限制这次 Graph 的活动节点数；它不是多个 run 共享的限流器。独立 Worker 容量也影响可用性，容量不足可能出现 NoWorkerAvailableError，不会自动排队。部分结果示例每个分支使用一个顺序 Graph，最多同时发出八次 run；不实现另一套通用调度器。

Graph 只在抛出异常时停止新节点调度，并等待已经开始的节点结束。INFER NodeResult 或 INTERACTION ExternalResult 的 failed 仍是业务数据，因此绑定函数显式检查 status，并校验模型 finishReason、JSON 和字段。部分结果的 allSettled 捕获每个分支 Graph 的拒绝；成功分支可以继续完成保存。signal 取消后不把中止任务包装为正常 partial 报告，已完成的文件不会回滚。

## 模型规划契约

规划输入为业务目标与应用提供的来源目录，输出为 `{ tasks }`。任务仅允许：

```json
{
  "tasks": [
    { "id": "extract_north", "kind": "extract", "sourceId": "north", "dependsOn": [] },
    { "id": "extract_south", "kind": "extract", "sourceId": "south", "dependsOn": [] },
    { "id": "consolidate", "kind": "summary", "dependsOn": ["extract_north", "extract_south"] }
  ]
}
```

应用检查每份来源恰好出现一次、任务 ID 唯一、独立提取为空依赖、summary 恰好依赖全部提取任务。通过后才保存 plan.json 并读取实际文件。模型不提供文件访问路径、工具权限或可执行代码；这些始终来自应用目录及白名单。

## 应用文件工具

`createOrderFiles({ inputDirectory, outputDirectory })` 返回 `{ tools, output, batchDirectory, pathFor }`，不注册 Core 配置项。

| 工具 / 适配器 | 输入与效果 |
| --- | --- |
| read_order_source | `{ sourceId, path }`；读取目录内不超过 1 MiB 的 UTF-8 文本，返回 text 和 SHA-256 |
| save_order | `{ batchId, sourceId, sourceSha256, record }`；验证 `{ code, quantity, unitPriceCents }`，计算 totalCents，持久保存订单 |
| save_parallel_plan | `{ batchId, plan }`；保存应用已经验证过的模型计划 |
| build_order_report | `{ batchId, successIds, failures }`；重新读取成功订单，拒绝重复/交叉 ID，计算安全整数总额，保存报告 |
| output | 检查消息与实际 report.json 一致，保存 delivery.json，返回 accepted 和产物引用 |

产物采用不覆盖发布，同内容重试幂等，不同内容产生冲突。报告业务 status 与输出 receipt.status 分别解释，不能把已交付的 failed 报告视为业务成功。

完整命令、文件组织、错误码和可重复的真实任务实验见[示例说明](../../examples/control-flow/parallel/README.zh-CN.md)。验收入口为 `npm run check:examples:parallel:tasks:package`，包含实际执行重叠、模型计划执行、结果等待与部分失败保留。
