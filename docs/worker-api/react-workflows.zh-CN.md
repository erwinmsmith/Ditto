# ReAct 持久化任务 API

完整入口通过一次 `runtime.loop(runReactLoop, [input, options])` 执行。生成器用 `graphStep` 调度判断、行动和观察 Graph。模型用原生 `SampleOutput.actionRequests` 选择工具，下一轮接收与动作 ID 对应的真实 `INTERACTION.OBSERVE` 输出。

## 完整消费者调用

复制 `examples/patterns/react`、应用工具 `react`、`storage`、`evidence.ts`、`execution/files.ts`、`operations/sdk.ts`、`operations/dependencies/package.json` 到消费者工程。安装 `@ditto/core`、`redis`，浏览器路径另装 `playwright` 和 Chromium；配置模型和 Redis，使用 Node 24+ 执行。模块导入不会启动服务、连接数据库或调用模型。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createDemo } from "./examples/_shared/tools/react/service.ts";
import { createTask } from "./examples/_shared/tools/react/adapters.ts";
import { openReact } from "./examples/patterns/react/cli.ts";
import { runReact } from "./examples/patterns/react/index.ts";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_REACT_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-react-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-react-tasks/client-"));
const demo = await createDemo(directory, "transient");
let app: Awaited<ReturnType<typeof openReact>> | undefined;
try {
  const request = await createTask(directory, demo.request);
  app = await openReact(directory, request, config);
  const result = await runReact(app.runtime, {
    request,
    model: { provider, model },
  });
  console.log(JSON.stringify(result));
} finally {
  try {
    await app?.close();
  } finally {
    await demo.service.close();
  }
}
```

该代码块由包外验收提取、严格编译并实际运行。

## 公开 API 组合

| 阶段   | API                              | 职责                                           |
| ------ | -------------------------------- | ---------------------------------------------- |
| 上下文 | CONTEXT.LOAD                     | Redis 会话、可信请求、实际工具消息和控制器反馈 |
| 判断   | INFER.REASONING.SAMPLE + actions | 生成原生工具请求或提出最终结果                 |
| 行动   | INTERACTION.ACT.TOOL             | 在沙箱和任务权限内派发应用工具                 |
| 观察   | INTERACTION.OBSERVE              | 保留成功、失败和未知结果，关联动作 ID          |
| 持久化 | MEMORY.GET / WRITE / UPDATE      | 副作用前保存意图，记录结果、观察、预算和报告   |
| 调度   | loop / graphStep / runtime.loop  | 阶段组合、继续、分支、检查点与停止             |

已有 `runReactFlow` 是临时执行的轻量便捷入口，不提供本示例的 Redis 历史、数据库检查点和业务核验。这里通过相同公开节点组装主 Loop，不在 Graph 内嵌套该入口，也不读取它的源码实现。`runReact`、`ReactAdapters` 属于应用示例 API，不是 Core 业务接口。

## 请求与工具

可信控制器提供 `id`、`tenant`、`principal`、`jobId`、`goal`、固定服务 `origin`、`mode`（inspect/recover）、`delivery`（api/browser）和预算。模型不能扩大任务对象、任意 URL 或工具权限。宿主负责认证和权限签发；参考服务是实际工作的本地 HTTP/SQLite 环境，不是生产身份认证服务。

模型目录包含 job_status、job_logs、runbook_search、job_retry（仅 recover），以及 job_result 或 job_result_browser。浏览器路径实际启动 Chromium、填写任务 ID、点击查询和下载、保存 CSV 和截图。本地手册工具读取 UTF-8 文档；外部知识库可通过替换应用适配器接入。HTTP 和浏览器路径复用同一个 ReAct 控制器及结果校验器。

瞬时故障恢复必须具备日志和匹配的手册证据；永久权限故障需人工处理。每次恢复 POST 前查询任务幂等键，参考服务在事务中保存效果和回执。响应丢失、取消和进程结束不能当成回滚证明。不确定结果进入 Observation，模型可查询状态再继续。`needs-human` 仅是供宿主路由的报告结果，不发送消息。

## 结果核验与停止

模型最终提出 `{status, summary, totalCents, evidenceIds}`。可信工具重新读取业务状态、核验 CSV 算术和引用证据，并生成内容哈希绑定的核验凭据。错误总额或过早完成会变成控制器反馈，进入下一轮判断。发布摘要由已核验字段生成；模型自由文本不能凭空宣称成功。输出保留公开动作与观察，不展示私有推理过程。

| 参数               | 范围   | 含义                                           |
| ------------------ | ------ | ---------------------------------------------- |
| maxSteps           | 1–20   | 模型派发尝试预算                               |
| maxActions         | 0–20   | 模型选择的工具派发尝试预算                     |
| maxRepeatedActions | 1–4    | 完全相同动作与结果的重复上限                   |
| deadlineSeconds    | 1–1800 | 从持久化开始时间计算的新工作调度期限，包含暂停 |

预算在派发前登记，恢复后不重置；未知的中断尝试可能保守重复计数。控制器授权、验证和发布不计入模型动作预算。新副作用需要保留后续模型观察轮次；整个动作批次先校验再执行。即使模型一次请求多个工具，本示例也顺序执行。

截止时间约束调度，不是整个任务的硬超时；已派发的模型和工具有各自超时。`signal` 取消外层 Loop 并传播给支持取消的工具，但不撤销服务端效果。结果状态为 completed、needs-human、partial；停止原因区分完成、人工介入、步骤/动作预算、无进展、截止时间和非法决策。部分结果不包含未经核验的总额。

## 存储、恢复与交付

`runReact(runtime, input, {stopAfter: "decision" | "observation" | "report", signal})` 返回检查点或报告。使用相同请求和目录恢复；变更范围、权限或预算请新建任务。单目录只运行一个实例，分布式并发需应用互斥。

Redis 保存活跃 Context；文件 SQLite `memory.sqlite` 保存 Memory。Redis 过期后由数据库记录重建历史；Redis/数据库不可用时返回错误，不静默使用内存替身。`service.sqlite` 是独立业务数据库，不代替 Memory。

工具证据与验证凭据按哈希绑定内容；发布会核对每个成功 Observation 对应的快照。保存后的已验证报告无需新模型/网络调用或恢复写入即可重放发布。产物为 `output/report.md`、`output/report.json`、证据与验证文件；浏览器路径额外包含 `download.csv`、`browser.png`。冲突内容或被篡改文件会报错，不覆盖。

## 端到端验收

包外安装实际 tarball，无 paths 别名，严格编译、限制运行时导入、检查静默导入并实际运行文档例子。真实模型、Redis、SQLite、HTTP 服务及 Chromium 验证实际业务效果、只发生一次的成功恢复、文件与报告，并覆盖未知结果、权限错误、恶意输入、预算、非法动作、错误总额纠正、缓存过期、存储故障、强制结束进程及交付重试。

模型故障注入明确标记，与正常自主选择的轨迹区分。这些测试运行在受控本地环境，不等同于验证任意外部网站或生产服务。第三方工具配置见 [ReAct 应用工具](../../examples/_shared/tools/react/README.zh-CN.md)。
