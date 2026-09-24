# 人工介入控制：公开 API 用法

[English](human.md) · [Runtime](runtime.zh-CN.md) · [五类示例与命令](../../examples/control-flow/human/README.zh-CN.md)

应用用公开 `graph`、`runtime.run`、`CONTEXT.LOAD`、`INFER.REASONING.SAMPLE`、`INTERACTION.ACT.TOOL` 和 `INTERACTION.OUTPUT` 组合人工介入流程。任务状态、审核策略、候选版本和效果记录由应用工具持久化。Core 无须增加业务审批 API，也不把交付回执解释为人工批准。

## 接入与完整调用

使用 Node.js 24+，在安装 `@codesoul-co/ditto` 的应用中复制 `examples/control-flow/human/` 和 `examples/_shared/tools/human-review-store.ts`，保留相对路径；准备 `ditto.yaml` 与 `.env`。这些示例是应用源码，不是 Core 的包导出。适配器仅依赖 Node.js 标准库，包括 `node:sqlite`。

下例创建一个等待确认的任务，并定义可信应用控制器接收人工决定后的继续入口。不要把 `onHumanDecision` 注册为模型工具；`actor` 应来自已验证的会话，不能直接信任请求中的用户名。

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { HumanReviewStore } from "./examples/_shared/tools/human-review-store.ts";
import { createFixture, reviewers } from "./examples/control-flow/human/fixtures.ts";
import { runApproval } from "./examples/control-flow/human/approval.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const input = { id: "task", model: config.model };
const directory = await mkdtemp(join(tmpdir(), "ditto-human-"));
await createFixture(directory, "approval");

function open() {
  const store = new HumanReviewStore(directory, reviewers);
  const runtime = createDitto({
    config,
    sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
    workers: [
      createContextWorker(),
      createInferWorker(),
      createInteractionWorker({ tools: store.tools, output: store.output }),
    ],
  });
  return { store, runtime };
}

const first = open();
try {
  await first.store.create(input.id, "approval");
  const pending = await runApproval(first.runtime, input);
  console.log({ directory, request: pending.request, stage: pending.job.stage });
} finally {
  await first.runtime.close();
  first.store.close();
}

// Invoke only from the application's authenticated human-decision handler.
export async function onHumanDecision(decision: {
  requestId: string;
  expectedToken: string;
  choice: "approve" | "reject";
  actor: string;
}) {
  const next = open();
  try {
    next.store.decide(decision);
    return await runApproval(next.runtime, input);
  } finally {
    await next.runtime.close();
    next.store.close();
  }
}
```

新进程应从应用配置读取原目录，重新构建同样的 Runtime 和 Store，然后调用对应流程；不要再次调用 `create` 或重建输入。CLI 展示了完整的跨进程调用方式。`reviewers` 是示例策略，生产应用应注入自己的审核权限表。

## 流程函数

五个导出函数分别为 `runApproval`、`runIntermediate`、`runEditContinue`、`runReviewPublish`、`runEscalation`，文件与命令见[示例指南](../../examples/control-flow/human/README.zh-CN.md)。统一签名：

```ts
(runtime: Pick<DittoRuntime, "run">,
 input: { id: string; model: ModelConfig },
 options?: { signal?: AbortSignal }) => Promise<HumanResult>
```

`HumanResult` 包含 `job`、`artifact: Version | null`、`request: ReviewRequest | null`。`job.mode` 必须匹配所选函数。等待确认、拒绝、交接和完成都正常返回持久化状态；工具失败、校验失败或取消会抛出错误。`runEscalation` 将模型失败或不可用输出转为人工交接；取消和其他错误仍向调用方传播。

| 状态 | 含义与下一步 |
| --- | --- |
| `queued` | 已保存输入；读取资料并创建 Context |
| `drafted` | 已保存版本；创建并交付审核单 |
| `awaiting-review` | 等待人工决定或允许的编辑；重入只重交付同一快照 |
| `approved` | 下次调用执行准确的审核版本；阶段确认/编辑流程先进行下游推理 |
| `rejected` | 终止本次执行，保留拒绝信息 |
| `executing` | 已持久化待执行效果；重入核对并继续同一快照 |
| `completed` | 效果与结果已保存；重入返回已有结果 |
| `escalated` | 人工交接；认领只设置负责人，不自动恢复执行 |

生成前的公开 Context 先持久化，使模型失败时仍能交接已有资料。审核单包含完整 `proposal`、`version`、`artifactDigest`、`sourceDigest`、操作类型与目标；激活操作还绑定目标初始内容摘要。输出 Sink 写出准确快照之后才标记 `delivered`。`accepted` 回执表示展示成功，后续仍须 `decide`。

## 应用审核控制器

`HumanReviewStore(directory, reviewers)` 打开已存在目录中的 SQLite。`ReviewerPolicy` 为 `Readonly<Record<string, readonly Purpose[]>>`；用途是 `activate`、`intermediate`、`edit`、`publish`、`handoff`。

| 方法 | 参数 / 返回与约束 |
| --- | --- |
| `create(id, mode)` | 读取 `<id>.source.json` 与 `<id>.deployment.json`，保存初始状态，返回 `Promise<HumanJob>`；仅用于新任务 |
| `job(id)` | 返回持久化任务；未知 ID 或不支持的 schema 拒绝读取 |
| `version(id, version?)` | 读取指定或最新不可变版本并检查摘要 |
| `request(requestId)` | 读取审核单并验证快照 token |
| `decide({ requestId, expectedToken, choice, actor, note? })` | `choice` 为 `approve` / `reject`；必须已交付、待决定、当前版本且角色有权限；返回更新后的任务 |
| `edit({ requestId, expectedToken, replacement, actor, note })` | 仅 `edit` / `publish`，限等待审核或批准但未执行时；创建完整新版本，旧审核作废；返回 `drafted` 任务 |
| `claim({ requestId, expectedToken, actor, note })` | 仅待认领交接单；记录审核身份与说明，设置 `assignee` |
| `close()` | 关闭 SQLite，须在 Runtime 完成后调用 |

`decide`、`edit`、`claim` 是可信应用控制器方法，不在 `store.tools` 中。token 是审核快照的 SHA-256 摘要，用于内容和作用范围绑定，不是认证秘密。审核单必须通过应用认证与权限检查后才能提交决定。

人工编辑后，需要再次调用对应流程交付新审核单，再提交新 request/token 的批准，最后调用流程继续。编辑不自动批准，旧 token 不能授权新内容。人工替换必须包含完整 `{ releaseId, date, title, body }`，不能更换 `releaseId`。下游日历推理只读取最新批准版本；落地工具再检查版本、摘要和输出字段，阻止推理期间发生编辑后的旧结果写入。

ID 为 1–64 位字母、数字、下划线或连字符；资料包含 1–8 个唯一来源 ID。日期为有效 `YYYY-MM-DD`，标题最多 200 字符，正文最多 4000 字符，原始变更句最多 1000 字符，编辑和认领说明为非空且最多 1000 字符。

## 工具与交付边界

| 应用工具 | 职责 |
| --- | --- |
| `human_read` | 读取任务、候选版本和审核单 |
| `human_source` | 读取真实输入文件并校验资料摘要 |
| `human_save_context` | 在推理前保存公开 Context 和输入摘要 |
| `human_save_draft` | 校验源事实并保存首个模型版本和 Context |
| `human_request_review` | 持久化审核或交接请求，尚不授予执行权限 |
| `human_apply` | 校验批准与准确版本，登记待执行效果，再写实际文件 |
| `human_report` | 保存并返回完整任务结果 |

`store.output` 实现 `OutputSink`，由 `createInteractionWorker({ tools: store.tools, output: store.output })` 注入。执行工具通过 `RegisteredTool` 注入并显式列入 sandbox；保留配置中的网络策略以允许模型访问。工具元数据不能替代 `human_apply` 内部的授权检查。

发布直接写审核快照中的正文。私有日历先验证模型生成的 `{ releaseId, date, title }` 与已批准版本完全相同。失败或进程中断后，持久化效果使用原版本继续，不要求重新生成内容；相同内容文件可复用，冲突文件不覆盖。目标漂移、部分文件写入和取消需要应用核对，不能把异常当作自动回滚。该本地文件适配器假定应用控制目录；外部系统应提供条件写入或事务和幂等协议，文件摘要检查不构成跨系统事务。

异常交接快照包含任务、来源、公开 Context、事件及可用的候选草稿；原因包括 `CONFLICTING_DATES`、`MODEL_FAILED`、`MODEL_INVALID`、`HUMAN_REVIEW_REQUIRED`。认领保存身份与说明，保留 `escalated` 状态。资料冲突也会把普通确认流程路由到交接，不会强行使用首个日期执行。

## 任务验收

[任务实验](../../scripts/check-examples-human-tasks.ts) 检查 18 个真实任务场景，包括实际收件箱交付故障、`SIGKILL` 后恢复、人工编辑跨进程恢复、推理期间修改、拒绝与失效审核、准确版本发布和目标变化。人工决定由测试控制器模拟，模型请求使用真实 Provider；失败模型输出另外由离线回归验证。[包实验](../../scripts/check-examples-human-package.ts) 在仓库外安装 `npm pack` 产物，严格类型检查不使用源码路径别名，再运行完整任务验收。命令、目录和报告见[示例指南](../../examples/control-flow/human/README.zh-CN.md)。
