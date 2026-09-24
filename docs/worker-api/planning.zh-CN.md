# 规划与任务管理：公开 API 组合

[English](planning.md) · [API 索引](README.zh-CN.md) · [五个示例](../../examples/capabilities/planning/README.zh-CN.md)

规划示例以本地补货报告为业务目标。模型提出任务与工具，应用验证依赖、资源和预算后构建执行 Graph。所有框架调用来自已导出的 `@ditto/core/...` 入口；不使用 Core 源码、私有执行器或直接 HTTP 模型请求。

## 公开接口映射

| 公开接口 | 示例用途 |
| --- | --- |
| `createDitto`、`graph`、`ExecutionGraph`、`DittoRuntime.run` | 注册 Workers，运行规划图、动态任务图、存储图和交付图 |
| `createContextWorker({ redis })` / `CONTEXT.LOAD`、`CONTEXT.UPDATE` | 按会话 scope 读取和更新真实 Redis Context |
| `createMemoryWorker({ store })` / `MEMORY.GET`、`MEMORY.WRITE` | 数据库请求、计划和结果归档 |
| `createInferWorker` / `INFER.REASONING.SAMPLE` | 将目标、工具目录和约束转成结构化计划 |
| `createInteractionWorker({ tools, output })` / `INTERACTION.ACT.TOOL`、`INTERACTION.OUTPUT` | 通过应用工具执行任务、登记检查点并交付实际报告 |

角色定义、工具目录、预算价格、调度规则、SQL 账本和文件格式属于应用。实现位于 [planning-domain.ts](../../examples/_shared/tools/planning-domain.ts)、[planning-store.ts](../../examples/_shared/tools/planning-store.ts) 和[编排入口](../../examples/capabilities/planning/shared.ts)，没有给 Core 增加业务专用节点。

## 初始化与执行

先按[存储指南](../../examples/_shared/tools/storage/README.zh-CN.md)安装 Redis SDK、启动 Redis，并配置模型。下面的代码放在应用根目录；相对导入的文件是随应用复制的示例代码。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { PlanningStore } from "./examples/_shared/tools/planning-store.ts";
import { createFixture } from "./examples/capabilities/planning/fixtures.ts";
import { runPlan } from "./examples/capabilities/planning/plan.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a model");
await mkdir(".examples-planning-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-planning-tasks/app-"));
await createFixture(directory, "plan"); // 应用可改为准备自己的请求和数据文件
const storage = await openAgentStorage(directory, config);
const store = new PlanningStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [
    ...storage.workers, createInferWorker(),
    createInteractionWorker({ tools: store.tools, output: store.output }),
  ],
});
try {
  await store.create("plan");
  const planned = await runPlan(runtime, { model: config.model }, { planOnly: true });
  console.log(planned.plan, planned.schedule);
  const completed = await runPlan(runtime, { model: config.model });
  console.log(completed.rows, completed.usage);
} finally {
  try { await runtime.close(); }
  finally { try { await storage.close(); } finally { store.close(); } }
}
```

恢复时打开原目录，不再创建 Fixture 或调用 `store.create()`。`openAgentStorage(directory, config)` 返回 `workers`、`redis`、`close()`，分别注入真实 Redis Context 和独立 `memory.sqlite` Memory。SDK 与连接均由应用持有。

## 应用调用契约

五个入口 `runPlan`、`runDecomposition`、`runDependencies`、`runBudget`、`runTools` 均接受：

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { model: ModelConfig },
 options?: { signal?: AbortSignal; planOnly?: boolean }) => Promise<Job>
```

创建时的 mode 分别为 `plan`、`decompose`、`dependencies`、`budget`、`tools`，必须与入口匹配。每个目录对应一个任务；`namespace` 使用持久化 UUID 隔离 Redis 和 Memory。

`PlanningStore` 是应用控制器：

- `create(mode)`：读取并验证请求与原始文件，记录摘要和创建时间。
- `job()`：读取业务状态、计划、调度、预算使用、检查点、归档标志与结果。
- `retry(stoppedOwner?)`：修复故障后保留成功检查点；活跃状态必须提供经外部确认已停止的 owner。此方法不注册为模型工具。
- `tools` / `output`：注入 Interaction Worker 的业务工具与文件交付端。
- `close()`：关闭业务数据库。

会话身份、目录访问和恢复授权由调用应用验证，UUID 和 owner 不替代身份认证。源文件路径由应用固定为销售和库存文件，不接受模型提供路径或命令。

## 计划校验与调度

模型计划为 `{ goal, tasks: [{ id, role, tool, dependsOn, reason }] }`，必须包含五个不同角色：`sales`、`stock`、`demand`、`replenish`、`report`。

`validatePlan(value, request)` 校验工具白名单、角色覆盖、唯一 ID、依赖存在性、规定的输入输出关系、解析器和分析质量。循环、自依赖、遗漏前置关系或额外工具会失败。输入顺序不必是拓扑顺序；应用根据校验结果生成执行顺序。

`schedulePlan(plan, budget)` 按就绪任务和资源容量计算批次。动态 Graph 使用语义依赖和批次屏障，以 `runtime.run(execution, { owner }, { concurrency, signal })` 执行。每个后继绑定先检查前置工具的 `ExternalResult.status`，应用账本还会检查前置任务是否真正完成。

独立的销售和库存任务可以同批执行，计算补货必须等待库存与需求结果。每个工具启动前通过事务认领检查点，预留调用次数、成本和资源；完成后保存真实输出。成功检查点再次进入时直接返回，不重复执行或计费。

## 预算与停止

规划前的 `preflight(request)` 只计算可行性下界，不替代模型生成计划。无法满足必需任务、工具权限或资源的请求直接 `blocked`；可行请求才预留模型尝试并调用 Sample。

`budget` 包含 `maxModelCalls`、`maxToolCalls`、`maxCostCents`、`maxElapsedMs`、`concurrency`、`ioSlots`、`cpuSlots`、`memoryUnits`。应用使用目录中的固定参考价格；模型估计不具有执行权限。未完成尝试仍消耗预留额度，因此账本中的模型尝试数可包含 HTTP 开始前已取消的尝试。实验报告另行统计实际 Sample 调用。

执行准入重新计算剩余任务需要的次数和成本。每次工具调用及提交再次核对实际时间。截止信号由任务创建时间加 `maxElapsedMs` 计算，与调用方信号合并。实际超时、取消或预算不足会阻止后续提交；已保存的检查点不会自动回滚。

时间估算包含固定模型估计与各批次最长工具估计，用于计划选择，不能保证供应商响应时间。逻辑资源单位控制任务并发，不等同于 OS 进程内存限制。参考成本不代表真实模型计费。

## Redis、Memory 和恢复边界

请求归档在推理前写入 Memory；规划完成后写入计划归档，成功确认后才启动业务执行。任务完成并交付后再归档结果。key 分别为 `planning:<namespace>:request|plan|result`，SQLite Memory 的相同 key/内容写入幂等，冲突内容被拒绝。

`prepareContext(runtime, job)` 通过 `MEMORY.GET` 读取已确认归档，然后 `CONTEXT.LOAD({ scope: { sessionId: namespace } })` 读取 Redis。仅 `CONTEXT_NOT_FOUND` 使用 Memory 内容初始化缓存；其他存储失败直接报告。业务库只保留任务账本，不作为 Context 快照兜底。

任务执行中的进程中断可能留下 `running` 检查点。确认进程停止后，可信控制器调用 `retry(owner)`，保留已完成任务并重试未完成任务。预算消耗和创建时间不重置。计划归档失败或交付失败通常直接重入即可，无需请求模型重规划。

`planOnly` 是检查和持久化计划的执行选项，不是审批系统；涉及真实外部采购等操作时，需要应用另行接入授权和副作用核对工具。

## 包消费者验收

```sh
npm run check
npm run check:examples:planning:tasks:package
```

验收在仓库外安装 tarball 和 Redis SDK，以无 `paths` 的严格配置检查应用代码，验证静默导入并限制 Core 入口。29 个真实任务实验检查文件产物的业务数值、任务依赖顺序、调用与成本消耗、Redis 值/TTL、Memory 数据，以及故障和跨进程恢复。

中间计划和最终报告实际落盘；测试不会将一次模型返回等同于任务完成。生成的报告、数据库、依赖目录和日志由 `.gitignore` 排除。
