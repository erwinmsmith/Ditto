# 请求理解与交互：公开 API 组合

[English](understanding.md) · [API 索引](README.zh-CN.md) · [六个可运行示例](../../examples/capabilities/understanding/README.zh-CN.md)

这组示例将用户请求转成发布报告任务，覆盖目标理解、约束识别、需求澄清、多轮对话、多选项交互和意图识别。六个入口通过公开节点构图，并由 `DittoRuntime.run()` 执行。业务会话、报告、权限规则和文件交付由应用适配器持有；这些业务类型不是 Core 新增 API。

## Core API 与应用职责

| 公开入口 / 节点 | 用途 |
| --- | --- |
| `@ditto/core/runtime`：`createDitto`、`graph`、`loadRuntimeConfigFile` | 注册 Workers、构图并运行 |
| `@ditto/core/worker/context`：`createContextWorker` | `CONTEXT.LOAD` 恢复历史；`CONTEXT.UPDATE` 合并当前会话轮次 |
| `@ditto/core/worker/memory`：`createMemoryWorker`、`MemoryStore` | `MEMORY.GET` 读取历史记忆；`MEMORY.WRITE` 归档已交付轮次 |
| `@ditto/core/worker/infer`：`createInferWorker`、`ModelConfig` | `INFER.REASONING.SAMPLE` 理解目标、参数与意图 |
| `@ditto/core/worker/interaction`：`createInteractionWorker`、`RegisteredTool`、`OutputSink` | `INTERACTION.ACT.TOOL` 调用应用工具；`INTERACTION.OUTPUT` 交付问题、选项或结果 |
| `@ditto/core/contracts`：`Context`、`ExternalResult` | 处理公开上下文数据，检查工具结果 |

模型只输出结构化理解结果；报告依据 `source.json` 中的实际资料确定性生成。用户输入、模型输出和助手问题分别保留，参数证据必须引用用户原文。业务工具位于 [understanding-store.ts](../../examples/_shared/tools/understanding-store.ts)，不依赖 Core 源码或私有 Worker 执行器。

## 初始化与调用

先按[存储接入](../../examples/_shared/tools/storage/README.zh-CN.md)安装 Redis SDK 并配置服务。`openUnderstandingStorage(directory, config)` 创建注入真实 Redis 的 Context Worker 和独立文件 SQLite 的 Memory Worker，返回 `workers`、`redis` 与 `close()`。

以下代码放在应用根目录。应用准备目录和资料文件后注入工具；示例的 `createFixture()` 也可以生成可运行资料。相对导入的是应用代码，安装 npm 包后将示例目录复制到应用即可使用。

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { UnderstandingStore } from "./examples/_shared/tools/understanding-store.ts";
import { runClarification } from "./examples/capabilities/understanding/clarification.ts";
import { openUnderstandingStorage } from "./examples/capabilities/understanding/storage.ts";

const directory = resolve("report-session");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "source.json"), JSON.stringify({
  topic: "ORION", changes: ["Added CSV export."],
  metrics: { testsPassed: 42, fixes: 3 },
}));
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure model.provider and model.model");
const storage = await openUnderstandingStorage(directory, config);
const store = new UnderstandingStore(directory);
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) },
  workers: [...storage.workers, createInferWorker(),
    createInteractionWorker({ tools: store.tools, output: store.output })],
});
try {
  await store.create("session", "clarification", "请为 ORION 生成面向工程团队的发布报告。");
  const result = await runClarification(runtime, { id: "session", model: config.model });
  console.log(result.view); // 已交付的问题、缺失字段、revision 与 token
} finally {
  await runtime.close();
  await storage.close();
  store.close();
}
```

恢复已有会话时重新打开同一目录并注册工具，不再调用 `create()` 或覆盖 `source.json`。由经过身份和会话权限校验的应用控制器接收真实用户回复，然后调用原入口：

```ts
store.receive({
  id: "session", messageId: "user-2", expectedRevision: 1,
  replyToken: deliveredQuestion.token,
  text: userReply,
});
const result = await runClarification(runtime, { id: "session", model });
```

`deliveredQuestion`、`userReply` 和 `model` 分别来自已交付响应、用户输入和应用配置。不要用模型生成的回复代替用户决策。`receive()` 和 `choose()` 是可信应用入口，不注册为模型工具。

## 六个应用入口

每个函数的签名为 `(runtime: Pick<DittoRuntime, "run">, input: { id: string; model: ModelConfig }, options?: { signal?: AbortSignal }) => Promise<Session>`。

| 文件 / 函数 | 创建会话时的 mode |
| --- | --- |
| `goal.ts` / `runGoal` | `goal` |
| `extract-parameters.ts` / `runConstraints` | `constraints` |
| `clarification.ts` / `runClarification` | `clarification` |
| `conversation.ts` / `runConversation` | `conversation` |
| `choices.ts` / `runChoices` | `choices` |
| `intent.ts` / `runIntent` | `intent` |

mode 与调用入口必须匹配。所有入口都执行完整理解、校验、澄清与交付流程；`choices` 额外在执行前等待选项选择。CLI 的 `clarification` 默认提供不完整请求，其余入口默认提供完整请求。显式调用可传入自己的用户消息。

## 参数、状态与回复协议

`Session.analysis` 包含 `intent`、`topic`、`audience`、`deadline`、`format`、`budgetCents`、`permission`、`scope` 和 `evidence`。目标用 `intent=create_report`、项目和受众表达。缺失参数为 `null`，不会从助手问题或默认方案补全。

- 意图为 `create_report`、`status`、`cancel` 或 `unknown`。查询与取消不要求补齐报告参数；未知意图先澄清。
- 时间必须包含日期、时间、时区，规范化为 UTC `YYYY-MM-DDTHH:mm:ss.000Z`。金额使用整数分，范围为 0 至 1,000,000。
- 格式为 `markdown` 或 `json`；受众为 `engineering` 或 `customers`；范围为 `changes`、`metrics` 或两者。
- 每个非空参数和明确意图具有 `{ turnId, quote }` 证据。验证引用来自真实用户轮次且原文包含该片段；这提供可追溯性，语义解释仍由模型完成，并受业务校验约束。
- 本地草稿是唯一允许的执行方式。`publish` 要求被拒绝；识别到权限要求不会授予权限。未知项目、过期时间、预算不足或资料变化也会阻止执行。

`Session.view` 是待展示/已交付响应，包含 `kind`、`text`、`missing`、`choices`、`analysis`、`artifact`、`revision`、`token` 与 `delivered`。只有 `INTERACTION.OUTPUT` 成功交付后才能回答问题或选择选项。token 绑定响应内容与版本，不是身份凭据。

| 应用方法 | 行为 |
| --- | --- |
| `create(id, mode, message)` | 从目录资料创建第 1 轮会话；已有 ID 报错 |
| `session(id)` | 读取 SQLite 中的权威会话状态 |
| `receive({ id, messageId, text, expectedRevision, replyToken? })` | 追加新用户消息并增加版本；等待问题/选择时必须带交付 token |
| `choose({ id, expectedRevision, token, choiceId })` | 选择已展示方案，增加版本后进入 `ready`；不再次调用模型 |
| `close()` | 关闭应用数据库；Runtime 由创建它的调用方关闭 |

同一 `messageId` 和同一内容的重试返回当前会话，不重复追加；同 ID 不同内容被拒绝。新消息必须匹配当前 revision。消息 ID 最多 64 位字母、数字、下划线或连字符；消息长度最多 8000 字符。选项不能重放到后续版本。

`brief` 成本为 500 分，`detailed` 为 1000 分；只展示预算内方案。选择 `detailed` 的 Markdown 报告增加阅读指引；JSON 通过 `style` 标识所选方案。成本仅用于本地预算校验，无支付操作。

## 执行图与恢复

控制器先通过 `MEMORY.GET` 读取 `memoryRevision` 指向的归档，尝试 `CONTEXT.LOAD({ scope })`。仅 Redis 缓存不存在或过期时，用 Memory 的历史轮次初始化该 scope；其他错误向调用方报告并释放推理认领以便重试。理解图依次执行带 scope 的 `CONTEXT.LOAD` → `CONTEXT.UPDATE` → `INFER.REASONING.SAMPLE` → 校验理解结果的工具。Sample 必须成功、以 `stop` 结束且返回可解析的 JSON；截断、供应商失败和无效证据会进入 `failed`。工具返回的 `ExternalResult.status` 也必须成功。

控制器依据持久化状态继续：参数缺失交付问题；等待选择交付候选项；`ready` 经工具执行报告登记；查询或取消只交付相应结果。展示图通过工具取得响应，再用 `INTERACTION.OUTPUT` 交付。交付后将完整交互经 `CONTEXT.UPDATE` 写回 Redis，并通过 `MEMORY.WRITE` 归档到 `memory.sqlite`，最后确认业务状态中的 `memoryRevision`。

会话使用事务认领和 revision 校验。推理过程中到达新消息时，旧结果不能覆盖新轮次。报告登记前重新检查资料摘要、期限、权限和预算，在一个 SQLite 事务中保存版本与完成状态，再导出不可变文件。文件交付故障可重入恢复，已交付轮次重入不会重复推理或登记。

`Session.namespace` 是持久化 UUID，会话 Context scope 为 `{ sessionId: namespace, turnId: String(revision) }`；Memory key 为 `conversation:<namespace>:<revision>`。业务库保存输入日志、事务状态及归档指针，不保存完整 Context。Memory 写入失败会返回错误，已经生成的报告保留；重入补写记忆。相同 key 与内容返回同一记录，内容冲突拒绝，从而覆盖数据库已提交、业务确认前中断的情形。

等待回复或选择时可以关闭进程，再打开同一目录继续。若进程在 `analyzing` 中断，应用应核对执行情况并实施自己的恢复策略；该示例不自动接管已有认领。取消信号不回滚已保存的报告。`Session.modelCalls` 是认领的推理尝试数，可能包括发起 HTTP 前取消的尝试；实验报告单独统计实际 Sample 调用。

## 包消费者验收

```sh
npm run check
npm run check:examples:understanding:tasks:package
```

包验收执行 `npm pack`，在仓库外安装 tarball，以无 `paths` 的严格配置检查应用代码，并验证六个入口静默导入。模块加载限制禁止访问仓库源码及 Core 私有路径，随后通过真实 HTTP 模型运行 25 个完整任务实验，检查真实 Redis 值与 TTL、独立 Memory 数据库、业务 SQLite、交互收件箱和报告文件，包括两个等待边界的进程强制中断恢复，以及缓存过期、存储故障和 Memory 已提交后的进程恢复。

报告保存在 `.examples-understanding-package-live-results.json`。模型、任务输入、轮次、结果和调用轨迹可用于复核。测试控制器模拟用户回复和选择；任务产物由实际应用工具生成。
