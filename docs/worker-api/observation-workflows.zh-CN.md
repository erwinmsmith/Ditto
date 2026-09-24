# 执行结果理解 API

[English](observation-workflows.md) · [Worker API](README.zh-CN.md) · [五项示例](../../examples/capabilities/observation/README.zh-CN.md)

使用公开 `INTERACTION.OBSERVE` 保留工具结果语义，调用 INFER 理解业务含义，再通过公开 Context、Memory 与工具节点更新状态并执行后续动作。已有 API 能完成这五项能力，无需为“读取”“解析”“错误识别”等业务类别新增 Core 节点。

## 完整调用

使用 Node.js 24+，按 [示例安装说明](../../examples/capabilities/observation/README.zh-CN.md) 配置真实模型和 Redis。将以下代码保存到仓库根目录 `observation-example.ts`：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { ResultTools } from "./examples/_shared/tools/observation/tools.ts";
import { createFixture } from "./examples/_shared/tools/observation/service.ts";
import { sandbox } from "./examples/capabilities/observation/cli.ts";
import { run } from "./examples/capabilities/observation/normalize.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-observation-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-observation-tasks/example-"));
const fixture = await createFixture(directory, "normalize");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new ResultTools(directory, fixture.request);
    try {
      const runtime = createDitto({
        config,
        sandbox: sandbox(config, fixture.request),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      try {
        const result = await run(runtime, {
          request: fixture.request,
          model: { provider, model },
        });
        console.log(JSON.stringify({ directory, result }, null, 2));
      } finally { await runtime.close(); }
    } finally { adapters.close(); }
  } finally { await storage.close(); }
} finally { await fixture.service.close(); }
```

```sh
npm run build
node --env-file=.env observation-example.ts
```

这段代码从实际 HTTP 服务读取 CSV，将原始输出经 OBSERVE 送入模型，校验字段和计算结果，事务更新任务状态并交付 `artifacts/result.json`。替换入口与 `createFixture` 的模式可运行 `read`、`errors`、`state`、`interpret`。

`run(runtime, { request, model }, options?)` 只要求 Runtime 的公开 `run` 方法。`options.signal` 传播取消；`stopAfter: "observed"` 保存第一轮工具结果后暂停，`stopAfter: "decision"` 保存解释后、更新任务状态前暂停。暂停返回 `{ status: "checkpoint" }`；终态返回 `Report`。

## 工具结果与标准观察

执行 Graph 的两个节点：

| 节点 | 输入 | 直接输出 |
| --- | --- | --- |
| `INTERACTION.ACT.TOOL` | `{ call: { id, name, arguments } }` | `ExternalResult` |
| `INTERACTION.OBSERVE` | `{ result: effect }` | `Observation` |

这里没有 `NodeResult.output` 包装。OBSERVE 保留 `callId`、`source`、`status`、`structuredContent`、`error`、`references` 和 `metadata`，将原内容转为 `message`，其角色为 `tool`、名称为结果来源。参考流程显式核对这些字段，防止失败结果被变成成功或失去来源关联。完整契约见 [INTERACTION API](interaction.zh-CN.md)。

OBSERVE 负责标准化，不自动解析任意 CSV、不自动重试，也不更新 Context。流程随后以 `CONTEXT.UPDATE({ scope, add })` 写入观察，再从 Redis 加载当前上下文调用 `INFER.REASONING.SAMPLE`。INFER 与 MEMORY 返回 `NodeResult`，使用前需要检查 `status === "success"` 及 `output`；构造、路由和基础设施错误仍可能抛异常。

## 模型解释与证据校验

模型输出的应用契约为：

```ts
interface Decision {
  callId: string;
  orderId: string;
  totalCents: number | null;
  remoteState: "completed" | "failed" | "unknown";
  errorKind: "none" | "transient" | "permission" | "not_found" |
    "timeout" | "transport" | "invalid_output" | "business" | "cancelled";
  nextAction: "complete" | "retry" | "reconcile" | "escalate" | "stop";
  reason: string;
}
```

模型读取原始 Observation，解释 JSON / 固定格式 CSV，识别错误并提出下一步。应用的 `validateDecision` 根据原结果独立验证金额、订单、错误分类、动作与关联 ID；缺字段、额外字段、金额编造和不允许的动作都会失败。错误消息与外部内容作为数据，不能覆盖控制器规则。

HTTP 成功不保证业务完成；若业务字段 `status` 为 `failed`，进入 `needs_review`。超时和未知传输结果保持 `remoteState: "unknown"`，先查询实际远端状态。503 允许一次幂等重试；403/404 不自动重试；取消停止。最多两轮观察，即一次初始调用与一次后续动作；预算用尽后转为待核查状态。

## 状态更新与后续执行

通过注册工具 `result_commit` 在应用数据库事务内保存已校验解释、状态与版本。状态包括 `pending`、`waiting_retry`、`reconciling`、`completed`、`needs_review`、`stopped`。重复同轮同内容不增加版本，冲突或过期提交失败。后续 `result_retry` / `result_status` 还会检查任务库中的状态，避免未经允许执行动作。

`Report` 保存 `taskId`、模式、最终 `state`、逐轮 `{ result, observation, decision }` 及 `verified: true`。待核查与取消也是可验证的终态，不代表业务成功。报告包含实际错误和证据，供调用方决定如何展示或交给人工；本示例不发送人工通知。

## 检查点和数据库

Context scope 为 `observation:<tenant>:<id>`。通过 `MEMORY.GET/WRITE` 保存的 key 依次使用 `input`、`observed-0`、`decision-0`，必要时加 `observed-1`、`decision-1`，最后为 `report`；均带固定请求指纹。

观察在模型调用前落盘，解释在状态更新和后续操作前落盘。每次恢复使用已提交结果重建 Redis，避免重复模型调用。Redis 只在 `CONTEXT_NOT_FOUND` 时按缓存缺失处理，连接故障不回退到进程内存。Memory 不可用时停止推进任务。

`memory.sqlite` 属于 Memory Worker；`tasks.sqlite` 记录应用状态；`remote.sqlite` 属于 HTTP 服务。状态写入后的进程中断由幂等事件恢复，重试生效后的中断依赖远端幂等键恢复。Context/Memory/业务库不是跨系统事务，取消或超时不表示已回滚。

## 发布包验收

`npm run check:examples:observation:tasks:package` 在仓库外安装 npm tarball，复制应用示例并安装 Redis 客户端，使用严格 TypeScript 且不配置 paths，拦截私有 Core 入口与仓库回退，验证五个入口静默导入，再执行 32 个完整场景。所有 Worker 都由 Runtime 组装执行，业务适配器不进入 Core。

验收包含真实模型、Redis、HTTP/SQLite、CSV 原始输出、存储故障、错误解释拒绝，以及观察、解释、状态与重试后的进程中断恢复。未配置外部服务会报错，不将 mock 模型或跳过项视为完整验收。
