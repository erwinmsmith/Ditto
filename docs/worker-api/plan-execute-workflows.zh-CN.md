# Plan-and-Execute 工作流

通过一次公开 `runtime.loop` 调用完成：目标与约束理解 → 整体计划 → 依赖校验 → 逐步执行 → 结果核对 → 完成。业务环境变化时，根据最新状态修改剩余计划。应用定义业务契约与适配器，Core 提供 Graph、Loop、Infer、Interaction、Context 和 Memory；该组合不需要新增 Core 接口。

## 可运行调用

将代码放在消费者根目录，复制 `examples/patterns/plan-and-execute`、`examples/_shared/tools/plan-execute`、`examples/_shared/tools/storage`、`examples/_shared/tools/evidence.ts` 和 `examples/_shared/tools/execution/files.ts`。安装 Core tarball 与 `storage/dependencies/package.json` 中声明的 Redis 依赖。使用 Node 24、真实 Redis、`ditto.yaml` 和环境变量中的模型凭据；通过 `DITTO_WORKER_CONTEXT_REDIS_URL` 指定 Redis。需要保留产物时，使用固定任务目录并移除最外层清理。

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/plan-execute/adapters.ts";
import { openPlanExecute } from "./examples/patterns/plan-and-execute/cli.ts";
import { runPlanExecute } from "./examples/patterns/plan-and-execute/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_PLAN_EXECUTE_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-plan-example-"));
try {
  const request = await createDemo(directory, "price-change");
  const app = await openPlanExecute(directory, request, config);
  try {
    const result = await runPlanExecute(app.runtime, {
      request,
      model: { provider, model },
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## API 与执行结构

| 阶段 | 公开节点/API | 数据契约 |
| --- | --- | --- |
| 加载/恢复 | `MEMORY.GET`、`CONTEXT.LOAD` | 任务指纹、历史计划、执行记录和持久化预算；缓存过期从 Memory 重建 |
| 理解与整体规划 | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | 完整步骤、依赖、预期结果，或有依据的人工升级 |
| 执行与观察 | `INTERACTION.ACT.TOOL` → `INTERACTION.OBSERVE` | 限定订单的调用和关联结果 |
| 结果核对 | `INTERACTION.ACT.TOOL`（`plan_check`） | 内容哈希证据与业务提交记录一致 |
| 检查点 | `MEMORY.WRITE` / `MEMORY.UPDATE` | 调用前保存预算，调用后保存结果 |
| 动态重规划 | `plan_snapshot`、Context、Infer | 最新状态、历史计划、完成项和失败条件 |
| 输出 | `plan_publish` | 核对后的运输回执、JSON 和 Markdown 报告 |

`runPlanExecuteLoop` 使用生成器计划，通过 `yield* graphStep` 组合各阶段 Graph，共享 1024 次 Graph 调度预算。Graph 内只有 Worker 节点。生成器不执行文件、数据库、网络 I/O，也不直接执行 Worker。`runPlanExecute(runtime,input,options)` 仅调用一次 `runtime.loop`。`Options.signal` 取消执行；`stopAfter: "plan" | "step" | "report"` 返回检查点。恢复时使用同一目录和不可变请求，去掉 `stopAfter`。这些函数是示例应用导出，不是新增的 Core 包导出。

## 计划与业务契约

请求固定租户、操作人、订单、目标、数量、运费上限、规划/模型调用预算、业务调用预算及总时限。用户偏好只能在这些约束内影响规划。Context scope 为 `plan-execute:<tenant>:<principal>:<id>`。模型返回 `{goal,status,reason,steps}`；步骤为 `{id,tool,dependsOn,expected}`。每版计划 ID 唯一，首步无依赖，后续步骤依赖前一步。此示例采用顺序依赖链；并行执行由单独模式展示。

计划必须覆盖当前状态下的全部剩余工作，包括回执读取。任意工具、额外参数、缺失步骤、依赖环、顺序错误、重复已完成工作或超预算承运商会在执行前被拒绝。不可行订单可以返回经校验的 `needs-human` 空计划。无效模型计划以 `invalid-plan` 停止，不用硬编码计划替代模型结果。

实际任务完成库存预留、打包、订运和回执读取。`price-change` 在打包事务中把 standard 运费从 300 分改为 900 分；预算 500 分，触发重规划，改选 400 分的 economy。`unavailable` 使两者都超预算，保留已预留、已打包状态供人工接手；`no-stock` 在执行前升级人工。`lost-response` 在提交订运后显式注入未知结果，下一次状态查询发现已订运，剩余计划只读取回执。

参考适配器操作真实 `business.sqlite` 事务，与 Memory 的 `memory.sqlite` 分离，不连接生产承运商。语义操作键为 `reserve_stock`、`pack_order`、`shipment`、`read_receipt`，与计划版本、模型步骤 ID 无关；两种承运商共享唯一订运键。每次写入在 `BEGIN IMMEDIATE` 内重新核对状态和价格；重试先读取提交记录，避免重复扣库存或订运。接入真实 ERP/承运商时，适配器必须通过服务端幂等键和状态核对保留该契约；这里不宣称跨服务分布式事务。

## 持久化、限制与产物

- Context 使用 Redis，长期 Memory 使用文件 SQLite。仅缓存不存在时重建；Redis/Memory 不可用会显式失败，不切换内存备用。
- 模型与业务调用前预留计数，跨重启和重规划沿用。崩溃可能消耗一次计数但没有已保存响应。`maxPlans` 限制实际模型尝试，不只是成功计划版本数。快照、核对和发布属于控制器调用，不占 `maxActions`，但占 Loop 的 Graph 预算。
- 总时限包含暂停时间，阻止新的计划/动作入场，不是已开始调用的硬超时。AbortSignal 用于取消运行；同步数据库事务原子完成。
- 每个目录只允许一个活动执行者。已完成报告是核对后的历史快照，重放不增加模型调用或订运。产物不可变，发布可重试；证据篡改和输出冲突显式报错。
- 运费与回执字段来自已提交业务记录，不采信模型自行声称的成功。产物包括 `shipment.json`、内容寻址的 `evidence/*.json`、`output/report.json`、`output/report.md`。报告保留所有合法计划版本、完成步骤和变更原因；部分完成或人工升级不声称已核对完成。
- 可信应用创建 `request.json` 和 `policy.json`；每个工具重新核对指纹和操作权限。本地策略文件展示接入方式，不充当身份认证服务，生产控制器应注入已认证身份并保护存储。

## 端到端验收

`npm run check:examples:plan-execute:package -- --provider deepseek` 在仓库外安装实际 tarball，无 paths 别名检查严格类型，检查公开导入边界及静默导入，执行真实模型任务和上方调用代码。用例核对实际库存、回执、文件、Redis 过期/不可用、Memory 故障、权限变更、非法计划、取消、响应丢失、预算/时限、进程强杀与发布重试。非法模型输出及响应丢失属于显式故障注入。SQLite 验收不代表 PostgreSQL/MySQL 已通过；可通过公开 `MemoryStore` 注入其他数据库并独立验收。
