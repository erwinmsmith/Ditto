# 任务生命周期控制：公开 API 用法

[English](lifecycle.md) · [Runtime](runtime.zh-CN.md) · [五类示例与命令](../../examples/control-flow/lifecycle/README.zh-CN.md)

应用通过公开 `graph`、`runtime.run`、`CONTEXT.LOAD`、`INFER.REASONING.SAMPLE` 和 `INTERACTION.ACT.TOOL` 完成任务。任务状态与执行权、业务对象版本、触发时间、事件去重和通知登记由应用适配器负责。Core 的取消信号传递可以直接复用，不需要添加业务任务或定时器 API。

## 完整调用

使用 Node.js 24+，在安装 `@codesoul-co/ditto` 的应用内复制 `examples/control-flow/lifecycle/` 和 `examples/_shared/tools/lifecycle-store.ts`，保留相对路径，并准备 `ditto.yaml`、`.env`。这些示例源码不是 Core 的 npm 包导出；适配器仅使用 Node.js 标准库。

下例保存一个绝对触发时间，到期后通过真实模型生成通知，并登记到本地业务表：

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { LifecycleStore } from "./examples/_shared/tools/lifecycle-store.ts";
import { createFixture } from "./examples/control-flow/lifecycle/fixtures.ts";
import { runScheduled } from "./examples/control-flow/lifecycle/scheduled.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const directory = await mkdtemp(join(tmpdir(), "ditto-lifecycle-"));
await createFixture(directory, "scheduled");
const store = new LifecycleStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [
    createContextWorker(),
    createInferWorker(),
    createInteractionWorker({ tools: store.tools }),
  ],
});
try {
  await store.create("task", { kind: "time", dueAt: Date.now() + 250 }, {
    modelCallBudget: 1,
    deadlineAt: Date.now() + 60_000,
  });
  const result = await runScheduled(runtime, { id: "task", model: config.model }, {
    waitMs: 2000,
    pollMs: 25,
  });
  console.log({ directory, result });
} finally {
  await runtime.close();
  store.close();
}
```

恢复等待中的任务时，打开原目录并构建 Runtime，然后调用对应流程；不要重新执行 `createFixture` 或 `create`。完成任务的重入返回相同业务结果。运行中的任务被强制终止后不自动重新认领，须由应用核对效果并选择恢复策略。

## 工作流接口

`runStatusTracking`、`runStateCheck` 和 `runSafeStop` 具有相同签名，复用同一执行协议：

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { id: string; model: ModelConfig },
 options?: { signal?: AbortSignal }) => Promise<Result>
```

`runScheduled` 和 `runEventTriggered` 额外支持 `options.waitMs` 与 `options.pollMs`。它们先等待应用触发条件，再调用相同执行协议。等待时间默认 60,000 毫秒，可设为 0–3,600,000；轮询间隔默认 50 毫秒，范围 5–10,000。窗口结束返回 `waiting`，不取消任务。等待时间只约束触发等待，不是模型执行期限；整个任务的期限由创建时的 `deadlineAt` 控制。

`Result` 包含：

- `job`：ID、业务 ID、期望版本、状态、原因、触发规则、期限、调用预算与已预留次数、执行权标识、创建和更新时间。
- `release`：从业务表读取的对象 `{ id, revision, status, title, change }`。
- `notice`：成功登记的 `{ releaseId, revision, title, body }`，未登记时为 `null`。
- `history`：按 `seq` 排序的 `{ seq, at, stage, reason }` 状态记录，时间为 Unix 毫秒。

应用错误一般持久化为 `failed`，停止条件为 `stopped`，随后返回完整结果。`blocked`、`waiting` 和其他终态同样正常返回。错误的调用参数、未知任务、无法持久化终态或无法导出报告仍会抛出异常；调用方应保留错误处理。

## 状态与执行边界

```text
manual: queued ─┐
time/event: waiting → queued → running → completed
                  │              ├→ blocked
                  └→ blocked     ├→ failed
                                 └→ stopped
```

就绪状态允许再次检查；`failed`、`stopped`、`completed` 是终态。执行协议包含：

1. 读取状态，跳过等待、终态和已被认领的任务。
2. 用 SQLite 事务检查期限、业务就绪状态、期望版本和模型调用预算；保存唯一执行权，预留一次调用并进入 `running`。
3. 通过公开 Graph 读取业务对象，加载 Context，调用模型生成通知。
4. 在登记事务中再次检查执行权、任务状态、期限、业务状态与版本，并校验模型结果保留源事实。
5. 在同一事务中插入 `notices` 并将任务设为 `completed`；导出结果快照。

同一任务只能被一个消费者认领。重复调用看到 `running` 会返回已有状态，不会重新推理。通知以任务 ID 为主键，防止同一任务重复登记；不同任务 ID 可登记独立通知。这是本地 SQLite 事务保证，不是任意外部 API 的 exactly-once 承诺。

`modelCalls` 表示已认领的推理尝试，可能因后续取消或准备失败尚未到达 Provider；`modelCallBudget` 不是 token 或费用预算。模型结果必须正常结束、为有效 JSON，并包含正确业务 ID、版本、标题和完整变更句，否则任务失败且不会登记。

## 应用存储与控制器

`LifecycleStore(directory)` 打开已存在目录中的 `lifecycle.sqlite`。输入文件 `<id>.source.json` 提供初始业务对象。后续以 SQLite 业务表为准，不通过重写输入文件更新已有任务。

| 方法 | 作用与约束 |
| --- | --- |
| `create(id, trigger?, limits?)` | 创建任务；默认手动触发。`limits` 为 `{ deadlineAt?: number, modelCallBudget?: number }`，默认预算 1 |
| `job(id)` | 读取持久化任务 |
| `business(releaseId)` | 读取业务对象 |
| `result(id)` | 读取任务、业务对象、已登记通知和有序状态历史，可用于轮询展示 |
| `updateBusiness(release)` | 可信应用控制器修改对象；版本不能后退，同版本不能修改标题或变更内容 |
| `requestStop(id, reason?)` | 持久化停止请求，默认 `OPERATOR_STOP`；不改写已有终态 |
| `acceptEvent(event)` | 校验事件与任务范围，原子去重并激活等待任务 |
| `close()` | Runtime 工作完成后关闭 SQLite |

`updateBusiness`、`requestStop` 和事件生产者不暴露为模型工具。它们代表已经完成身份认证和授权的应用控制器。示例 CLI 的 `--ready`、`--stop`、`--emit-event` 用于演示该边界，不提供身份认证服务。

ID 为 1–64 个字母、数字、下划线或连字符。版本为正安全整数，标题不超过 200 字符，变更句不超过 1000 字符，通知正文不超过 4000 字符。`dueAt`、`deadlineAt` 为非负 Unix 毫秒安全整数；预算为非负安全整数。业务状态为 `draft`、`ready` 或 `withdrawn`。

## 安全停止与取消

调用方的 `AbortSignal` 传入 Graph、交互工具与真实模型 Provider。执行期限使用同一取消机制，并在数据库写入前再次检查绝对期限。清理路径使用独立的未取消调用保存 `stopped / CALLER_CANCELLED` 或 `stopped / DEADLINE`，避免用已取消的 Graph 写终态。长期限按短间隔检查，避免 Node.js 单次定时器范围限制。

人工停止记录可以由另一个进程写入，随后登记事务会拒绝旧结果；跨进程的停止记录本身不会取消远端正在运行的 HTTP 请求。应用可以额外把停止请求转发到持有 `AbortController` 的执行进程。

取消发生在事务提交之后，返回 `completed` 并保留已经产生的效果；取消不意味着回滚。模型、解析或业务存储异常保存 `EXECUTION_FAILED`；事件输入错误保存 `TRIGGER_INVALID`。详细运行诊断可从 Runtime 执行轨迹关联，结果文件不保存供应商凭据。

## 时间与事件触发

`Trigger` 为 `{ kind: "manual" }`、`{ kind: "time", dueAt: number }` 或 `{ kind: "event" }`。触发规则在创建时固定。定时消费者只在实际时钟达到 `dueAt` 后把任务转为可执行；应用需保持消费者运行或再次唤起，Core 不提供操作系统级后台唤醒。

事件文件为 `inbox/<taskId>.json`，内容为：

```ts
interface Event {
  id: string;
  type: "release.ready";
  taskId: string;
  releaseId: string;
  revision: number;
}
```

[emitEvent](../../examples/control-flow/lifecycle/fixtures.ts) 校验事件结构，并用临时文件加原子重命名发布完整事件。生产者应写入受应用管理的目录；消费者校验事件类型、任务 ID、业务 ID 和期望版本。同事件 ID 的规范化内容一致时可重放，不一致则拒绝。事件接收和激活在同一 SQLite 事务中进行，停止任务不会被事件重新激活。

文件适配器用于展示一种实际事件来源，不实现邮件或消息平台协议。需要将那些平台的已授权事件映射成上述契约；本示例每任务一个输入槽位，不包含通用队列的归档、分区或消费确认机制。

## 工具与验证

| 工具 | 职责 |
| --- | --- |
| `lifecycle_read` | 返回任务与业务状态 |
| `lifecycle_activate` | 检查时间或读取实际事件文件 |
| `lifecycle_claim` | 事务检查前提与预算，取得唯一执行权 |
| `lifecycle_source` | 核对执行权后读取业务对象 |
| `lifecycle_commit` | 核对状态、版本、期限和结果，事务登记通知并完成任务 |
| `lifecycle_finish` | 保存执行失败或停止状态，不覆盖终态或其他执行者的任务 |
| `lifecycle_report` | 导出并返回结果快照 |

通过 `createInteractionWorker({ tools: store.tools })` 注入，并在 sandbox 中显式允许工具名称，保留配置中的模型网络策略。业务原子操作由工具实现；Core 承担 Graph 调度、节点调用及取消传递。

[任务验收](../../scripts/check-examples-lifecycle-tasks.ts) 使用真实模型、实际业务表、文件事件、独立进程和时钟覆盖 20 个场景。[包验收](../../scripts/check-examples-lifecycle-package.ts) 在仓库外安装 npm 打包产物并验证严格公开类型和静默导入，再执行完整任务。命令、目录及报告见[示例指南](../../examples/control-flow/lifecycle/README.zh-CN.md)。
