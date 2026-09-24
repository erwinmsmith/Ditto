# 深度研究工作流 API

一个完整研究 Agent 通过一次 `runtime.loop(runResearchLoop, [input, options])` 执行。计划生成器用 `graphStep` 调度扁平的阶段 Graph；Loop 管理阶段组合、循环、条件、预算与恢复。Graph 节点调用公开 Context、Memory、Infer、Interaction Worker，不嵌套子 Graph，也不直接执行 Worker。

## 完整调用

在消费者项目复制 `examples/patterns/deep-research` 及应用工具依赖：`research`、`web-search`、`storage`、`evidence.ts`、`execution/files.ts`、`retrieval/web.ts`、`retrieval/domain.ts`、`retrieval/dependencies/package.json`。安装 `@codesoul-co/ditto`、`redis`、`linkedom`，配置 `ditto.yaml` 和环境变量，使用 Node 24+ 执行：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createTask } from "./examples/_shared/tools/research/adapters.ts";
import { searchConfig } from "./examples/_shared/tools/web-search/providers.ts";
import { defaultRequest } from "./examples/patterns/deep-research/fixtures.ts";
import { openResearch } from "./examples/patterns/deep-research/cli.ts";
import { runResearch } from "./examples/patterns/deep-research/index.ts";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider =
  process.env.EXAMPLE_RESEARCH_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-research-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-research-tasks/client-"));
const search = searchConfig();
const request = await createTask(directory, defaultRequest(), search);
const app = await openResearch(directory, request, config, search);
try {
  const result = await runResearch(app.runtime, {
    request,
    model: { provider, model },
  });
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
```

该片段由包外验收脚本提取、严格编译并实际执行。`openResearch` 只负责注册公开 Worker 和管理连接生命周期；`runResearch` 是应用示例入口，并非 Core 内置业务 API。

## 请求与阶段契约

`Request` 包含可信身份 `tenant/principal`、任务 `id`、`question`、`researchType`、`audience`、`scope`、来源白名单、参考 URL 与预算。`researchType` 支持 market/industry/academic/competitive/policy，它们使用相同的证据流程，不表示自动获得专业数据源或专家资质。身份认证和权限签发由应用控制器完成。

规划输出目标、最多三个子问题及初始查询。每轮执行新查询、阅读实际 HTML、去重并累计证据，再输出每个子问题的覆盖状态 covered/gap/conflict、证据 ID、具体缺口和下一查询。后续查询来自这次评估，而非固定重复一组任务。主题含糊时返回澄清问题；证据缺失不伪装成用户请求不明确。

综合报告只使用选中片段中的精确原文引用，再由独立模型调用检查每条结论的依据和覆盖完整性；最多修订一次。核验通过意味着忠实交代已知与未知，并不要求所有研究问题都已解决。`allowPartial` 控制工具失败是否可保留其他成功来源，不禁止因证据或预算不足而输出诚实的部分研究报告。

## 预算与停止

| 参数            | 范围   | 含义                                               |
| --------------- | ------ | -------------------------------------------------- |
| maxQueries      | 1–3    | 每轮查询数和初始子问题数上限                       |
| maxPages        | 1–6    | 每轮候选网页数                                     |
| maxRounds       | 1–4    | 任务研究轮数                                       |
| maxSearches     | 1–12   | 整项任务搜索派发预算                               |
| maxReadPages    | 1–16   | 整项任务网页读取派发预算                           |
| maxModelCalls   | 8–24   | 整项任务模型调用预算                               |
| researchSeconds | 1–3600 | 从持久化开始时间计算的新研究工作调度期限，包含暂停 |

每次调用前通过数据库 Memory 记录预算；进程中断可能保守多计，不会因恢复重置。提供方内部传输重试仍属于一次派发，不等于额外搜索预算单位。预算限制调用次数，不直接计算货币成本。开始下一轮评估前预留四次模型调用，用于报告生成、核验及一次修订。

`stopReason` 区分 coverage-complete、round-budget、search-budget、page-budget、model-budget、deadline、no-progress、clarification。预算耗尽、缺少新查询、连续轮次没有新证据会停止；报告保留未解决问题，不根据检索不到推断事实不存在。

研究时间预算限制新研究工作调度，不是整项任务的硬超时；已派发的请求有传输超时，后续综合可继续。需要立即取消时传 `signal`，由外层 Loop 中止执行。

## 持久化与恢复

Context 使用真实 Redis；Memory 默认使用文件 SQLite，存储请求指纹、调用登记、模型输出、冻结的轮次计划、搜索/阅读结果及报告。Redis 过期可从 Memory 重建；存储不可用会报错，不静默切换内存。其他数据库通过公开 MemoryStore 适配器注入；SQLite 验收不等同于其他后端验收。

`runResearch(runtime, input, {stopAfter: "plan" | "round" | "report", signal})` 返回检查点或 `Report`。恢复传入相同请求和目录，重新验证权限与引用快照。已完成报告无需新模型/网络调用即可幂等重放发布。变更需求请新建任务；单目录同时只运行一个实例，分布式并发需应用加锁。

## 工具与产物边界

`ResearchAdapters` 复用网页搜索、阅读、快照和引用核对工具，并以研究授权、发布工具替换问答专用工具。所有工具通过 `INTERACTION.ACT.TOOL` 派发；Loop 不直接执行 IO。`research_publish` 输出 `output/report.md` 与 `output/report.json`，交付失败可以从保存的报告重试。

默认 MediaWiki 只检索指定 wiki；Brave 可配置全网搜索。参考 URL 也必须实际读取。正文工具支持 HTML 段落；PDF、动态网页、登录和付费文献需额外应用工具。搜索摘要不充当证据；原始 HTML、抓取时间、抽取段落号和 SHA256 随引用保留。抓取时间不是发表时间，段落号不是 HTML 源码行号。

累计证据最多 48,000 个序列化字符，最终最多八个片段，超出预算的来源与剩余缺口在报告中披露。大型研究由应用拆为有界任务。`crossCheck` 要求最终已回答结论具有不同来源 origin（协议、主机和端口）、不同正文和模型核验；origin 不同不自动证明出版方独立，也不能保证材料本身真实。

来源策略复用 HTTPS、DNS 地址固定、重定向检查、响应体上限、超时与重试规则。外部页面指令不能改变权限和预算。详情见 [联网搜索 API](web-search-workflows.zh-CN.md)。

## 验收

`check:examples:research:package` 在仓库外安装实际 tarball，无 paths 别名，检查公开入口、严格类型、静默导入和运行时解析边界，并实际执行上述文档例子与任务套件。真实公网与可控 HTTP 语料分别标记；两者使用真实模型、Redis 和 SQLite。语料要求先发现附录名称，再检索得到遗漏事实，包含交叉核验、冲突、恶意页面、预算停止、缓存过期、存储故障、强制结束进程及交付恢复。
