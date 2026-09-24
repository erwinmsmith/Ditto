# 2.1 顺序与步骤执行

[English](README.md) · [控制流程](../README.zh-CN.md) · [全部示例](../../README.zh-CN.md) · [Graph API](../../../docs/worker-api/runtime.zh-CN.md#graph定义-node-与连接)

通过 Ditto 的 Graph 构建器声明步骤、依赖和输入映射，由 Runtime 执行步骤与阶段，用 Loop 重复处理批次。

| 类型 | 定义 | 示例 | 核心 API |
| --- | --- | --- | --- |
| 固定步骤执行 | 按预先确定的步骤依次执行任务 | [pipeline.ts](pipeline.ts) | `graph().node()`、`runtime.run()` |
| 顺序执行 | 按前后依赖执行，并传递上一步结果 | [dependencies.ts](dependencies.ts) | `dependencies`、`bind` |
| 阶段式执行 | 一个阶段完成并校验后，进入下一阶段 | [stages.ts](stages.ts) | 多个 Graph、顺序 `await runtime.run()` |
| 批量执行 | 多个对象重复执行同一流程，统一汇总 | [batch.ts](batch.ts) | `loop()`、`runtime.loop()`、汇总 Graph |

固定步骤与顺序依赖例子的直接运行使用本地数据；阶段式和批量例子的直接运行调用真实模型。四种类型均由端到端命令验证真实模型链路。

## 运行

要求 Node.js 24+、npm 11+。在仓库根目录执行：

```bash
npm ci
npm run example:sequence:pipeline
npm run example:sequence:dependencies

# 配置 .env 中的默认模型和网络权限后运行：
npm run example:sequence:stages
npm run example:sequence:batch
```

命令先构建 `@codesoul-co/ditto`，再通过包的公开 exports 运行示例。每个文件可独立使用，导入文件不执行任务。

## 固定步骤执行：pipeline.ts

[pipeline.ts](pipeline.ts) 加载两条材料，再根据查询选出一条：

```text
loaded: CONTEXT.LOAD → selected: CONTEXT.SELECT
```

`PipelineInput` 包含 `items`、`query`、`limit`。`selected` 的依赖为 `["loaded"]`，其 `bind` 将 `loaded` 作为 SELECT 的 `context`，并从原始输入读取查询和数量限制。选择使用内置确定性策略，不调用模型。

默认输出：

```json
{
  "loadedItemIds": ["graph", "memory"],
  "selectedItemIds": ["graph"]
}
```

`runPipeline(input?)` 返回完整的 `{ loaded, selected }`，便于检查各步骤结果。修改查询为 `memory` 会选中另一条材料；空材料或 `limit: 0` 返回空选择。负数或非整数 `limit` 会由 CONTEXT 校验并拒绝执行。

## 顺序执行：dependencies.ts

[dependencies.ts](dependencies.ts) 在原始材料中加入一条新材料，选择后交付包含原始条目 ID 和选中内容的消息：

```text
loaded → updated → selected → delivered
   └─────────────────────────────↑
```

| 步骤 | Node | 直接依赖 | 输入来源 |
| --- | --- | --- | --- |
| `loaded` | `CONTEXT.LOAD` | 无 | 原始 `items` |
| `updated` | `CONTEXT.UPDATE` | `loaded` | 已加载上下文与 `additions` |
| `selected` | `CONTEXT.SELECT` | `updated` | 更新后的上下文、`query`、`limit` |
| `delivered` | `INTERACTION.OUTPUT` | `loaded`、`selected` | 原始条目 ID、选中内容和调用方的 `deliveryId` |

`delivered` 虽然通过 `selected` 间接依赖 `loaded`，但要在 `bind` 中读取 `loaded`，仍必须把它列入直接依赖。`updated` 不会传给该回调。CONTEXT.UPDATE 返回新的上下文，原始 `loaded` 结果仍可用于交付。

应用提供一个内存 OutputSink，将消息加入本次调用的 `deliveries` 集合并返回 `accepted` 回执；消息不会发送到外部系统，也不进行持久化。

默认输出：

```json
{
  "message": {
    "originalItemIds": ["graph", "memory"],
    "selectedItemIds": ["binding"],
    "selectedContent": ["A bind function maps dependency outputs to the next input."]
  },
  "receipt": {
    "deliveryId": "sequence-dependencies",
    "status": "accepted"
  }
}
```

`runDependencies(input?)` 返回 `{ loaded, updated, selected, delivered, deliveries }`。`delivered` 是 OUTPUT 回执，`deliveries` 是本地接收的消息。选中内容以文本交付，非字符串内容通过 JSON 序列化。真实交付系统应由应用分配符合其幂等约定的 `deliveryId`。

## 阶段式执行：stages.ts

[stages.ts](stages.ts) 将订单处理划分为两个 Graph：

```text
阶段一 preparationGraph：LOAD → SAMPLE（提取订单）
                           ↓ 完成并校验 Order
阶段二 completionGraph：SAMPLE（计算总价）→ OUTPUT
```

`runStages(runtime, input)` 先等待阶段一完成，校验 `code`、`quantity` 和 `unitPriceCents`，再将规范化的 `Order` 作为下一阶段的输入。第二次模型调用只接收阶段一的结果，不能绕过提取阶段直接使用原文。价格使用整数分，交付前校验编号和乘法结果。

默认输入为订单 `ORDER-731`、3 本笔记本、单价 1200 分；输出：

```json
{ "code": "ORDER-731", "totalCents": 3600 }
```

准备阶段失败或输出不符合结构时，不启动完成阶段；最终总价不符时，不执行交付。返回值 `{ order, prepared, completed }` 保留阶段间数据、模型调用结果和交付回执。

## 批量执行：batch.ts

[batch.ts](batch.ts) 为每个对象执行同一个 `batchItemGraph`：

```text
Loop：对象 1 [LOAD → SAMPLE] → 对象 2 [LOAD → SAMPLE] → 对象 3 [LOAD → SAMPLE]
        每轮 update 累积结果，done 判断批次是否完成
                                      ↓
batchSummaryGraph：OUTPUT（全部对象结果与总数量）
```

`runBatch(runtime, input)` 接收 `items`、`model`、`deliveryId`。对象 ID 必须非空且唯一；结果按输入顺序保留 ID，模型响应只能提供 `code` 和 `quantity`。`maxIterations` 显式设置为对象数量，批次不受默认 32 轮限制。

默认输出：

```json
{
  "items": [
    { "id": "first", "code": "PICKUP-101", "quantity": 2 },
    { "id": "second", "code": "PICKUP-202", "quantity": 5 },
    { "id": "third", "code": "PICKUP-303", "quantity": 3 }
  ],
  "totalQuantity": 10
}
```

空批次不进入 Loop、不调用模型，直接交付 `{ "items": [], "totalQuantity": 0 }`。任一对象调用失败、输出截断或结构不符时，停止后续对象处理，不交付成功汇总。返回值 `{ results, samples, receipt }` 包含逐对象结果、模型调用记录和统一交付回执。

## 在应用中调用

在已安装 `@codesoul-co/ditto` 的应用中复制需要的示例文件，即可从应用入口调用：

```ts
import { runPipeline } from "./pipeline.ts";

const result = await runPipeline({
  items: [
    { id: "api", content: "Graph dependencies determine execution order." },
    { id: "storage", content: "Memory stores long-term information." },
  ],
  query: "dependencies",
  limit: 1,
});
console.log(result.selected.selectedItemIds); // ["api"]
```

`pipeline.ts` 和 `dependencies.ts` 分别导出 `pipelineGraph`、`dependenciesGraph`，可交给应用自己的 `runtime.run(graph, input)`。前者需要注册 `createContextWorker()`；后者还需要 `createInteractionWorker({ output })`。接入自有 Runtime 时由应用管理其生命周期；这两个运行函数为每次调用创建 Runtime，并在 `finally` 中关闭。

| 包入口 | 使用的 API |
| --- | --- |
| `@codesoul-co/ditto/contracts` | `ContextItem` |
| `@codesoul-co/ditto/runtime` | `graph`、`loop`、`createDitto`、`loadRuntimeConfigFile`、`DittoRuntime` |
| `@codesoul-co/ditto/worker/context` | `createContextWorker` |
| `@codesoul-co/ditto/worker/interaction` | `createInteractionWorker`、`InteractionOutputInput` |
| `@codesoul-co/ditto/worker/infer` | `createInferWorker`、`ModelConfig`、`NodeResult`、`SampleOutput` |

阶段式和批量执行的函数接收调用方 Runtime，应用负责注册 Worker 和关闭资源：

```ts
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { runStages, stagesInput } from "./stages.ts";
import { runBatch, batchInput } from "./batch.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the default INFER model");
const runtime = createDitto({ config, workers: [
  createContextWorker(), createInferWorker(),
  createInteractionWorker({ output: { async deliver(input) {
    console.log(input.message.content);
    return { deliveryId: input.deliveryId, status: "accepted" };
  } } }),
] });
try {
  await runStages(runtime, { ...stagesInput, model: config.model });
  await runBatch(runtime, { ...batchInput, model: config.model });
} finally { await runtime.close(); }
```

示例不导入 `src/`、`dist/` 或其他示例模块，不要求应用配置 TypeScript `paths`。

## 真实模型端到端验证

[端到端验证脚本](../../../scripts/check-examples-sequence-live.ts) 直接复用本目录的 Graph 和执行函数。固定步骤与顺序依赖通过公开 `.node()` API 追加模型推理；阶段式和批量执行直接调用 `runStages`、`runBatch`：

```text
pipeline:
LOAD → SELECT → INFER.REASONING.SAMPLE → OUTPUT

dependencies:
LOAD → UPDATE → SELECT → OUTPUT（材料）→ INFER.REASONING.SAMPLE → OUTPUT（模型结果）
  └───────────────────────────────→ SAMPLE 同时读取原始材料

stages: preparationGraph → 校验 Order → completionGraph
batch: Loop [batchItemGraph × 3] → batchSummaryGraph
```

根据根目录 [`.env.example`](../../../.env.example) 配置 `.env` 中的模型 Provider、密钥、模型名称和 Sandbox 网络权限。推理预算和超时读取 [`ditto.yaml`](../../../ditto.yaml)。从仓库根目录运行：

```bash
# 使用 DITTO_WORKER_INFER_MODEL_PROVIDER 指定的默认 Provider。
npm run check:examples:sequence:live

# 对指定的已配置 Provider 分别执行四个例子。
npm run check:examples:sequence:live -- --provider deepseek,openai,glm
```

每个 Provider 验证四种执行类型，共执行七次真实 HTTP 模型调用：固定步骤 1 次、顺序依赖 1 次、阶段式 2 次、批量 3 次。脚本只注册内置 Worker，模型 Provider 由配置创建，不注入模型替身，也不在失败后切换到本地答案。

- **固定步骤**：每次生成随机提货码和数量，混入无关材料；模型仅接收 SELECT 的结果，提取 JSON，最终 OUTPUT 必须交付同一份模型响应。
- **顺序依赖**：每次生成不同的新旧编号，用 UPDATE 替换同 ID 的条目；模型同时读取原始 LOAD 与最新 SELECT 的结果，返回旧编号、新编号和最新数量，验证跨步骤数据未被覆盖。
- **阶段式**：随机生成订单编号、数量和单价，分别验证提取结果和下一阶段的总价。
- **批量**：三个不同编号和数量逐条推理，检查对象对应关系、输入顺序、逐项数量和统一汇总，只交付一次。
- 校验模型 `status`、`finishReason`、结构化答案、交付内容和回执，以及原始输入、上下文和交付次数。错误或截断不会作为成功结果继续交付。

报告写入 `.examples-sequence-live-results.json`（Git 忽略），记录 Provider、模型、执行 ID、耗时、usage、预期值、实际值和通过/失败结果；使用 `--report <path>` 可指定位置。断言失败或模型调用失败会使命令非零退出。

真实模型验证与 `npm test` 分开执行；此命令需要网络和凭据，并会产生模型调用费用。`npm test` 验证确定性的控制流程行为，示例验收同时要求真实模型链路通过。

## 执行语义

- `.node()` 返回新 Graph；使用链式调用或保存返回值。
- 执行顺序由依赖关系决定。将并发限制设为 1 只限制同时运行数量，不能替代数据依赖声明。
- `bind` 是同步的输入映射，接收原始输入和直接依赖输出；实际工作由 Node 执行。
- 上游节点或 `bind` 抛异常时，Runtime 停止启动后续节点并拒绝本次调用；已开始的分支会先结束。
- `status: "failed"`、`rejected` 或 `unknown` 等返回字段是普通结果，Graph 不会自动抛错。示例显式检查 OUTPUT 是否返回 `accepted`。

更多参数、绑定方式和取消语义见 [Runtime API](../../../docs/worker-api/runtime.zh-CN.md)。

包外安装验收：`npm run check:examples:sequence:package`。全部类别使用同一个 tarball 的检查见[统一包验收](../../../docs/worker-api/control-flow.zh-CN.md)。
