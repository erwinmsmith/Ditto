# 信息整理与分析：公开 API 组装

[English](analysis-workflows.md) · [API 索引](README.zh-CN.md) · [七个示例](../../examples/capabilities/analysis/README.zh-CN.md)

分析流程使用公开 Worker 接口，从实际材料生成有来源的事实与比较结果。模型负责提取；应用负责数据契约、可信参考配置、归一化、核验、计算和输出。

| API / 节点 | 职责 |
| --- | --- |
| `createDitto`、`graph`、`runtime.run` | 注册 Worker 并执行材料采集、模型提取、存储和输出图 |
| `createInteractionWorker({ tools })` / `INTERACTION.ACT.TOOL` | 文件解析、网页读取、快照、应用分析规则与报告文件 |
| `createInferWorker()` / `INFER.REASONING.SAMPLE` | 从 Redis Context 中读取材料并提取字段、数值、单位和原文引用 |
| `createContextWorker({ redis })` / `CONTEXT.LOAD/UPDATE` | 真实 Redis 上下文与缓存恢复 |
| `createMemoryWorker({ store })` / `MEMORY.GET/WRITE/SEARCH` | 数据库检查点和独立命名的内部长期知识 |
| `createRetrievalWorker({ providers })`、`createSqlSearchProvider` / `RETRIEVAL.SEARCH` | 按租户和已批准文档 ID 查询外部知识库 |

所有业务适配器位于 [tools/analysis](../../examples/_shared/tools/analysis/README.zh-CN.md)。无需新增与业务字段绑定的 Core 节点；不从 `src`、`dist` 或未导出路径导入实现。

## 完整调用

在应用根目录保存下面代码，配置 `ditto.yaml`、`.env`、Redis 和解析器环境。消费者安装 `@codesoul-co/ditto` 后复制 `examples/capabilities/analysis/`，以及 `examples/_shared/tools/` 下的 `analysis`、`file-ingestion`、`retrieval`、`storage` 目录；第三方依赖按[示例说明](../../examples/capabilities/analysis/README.zh-CN.md)安装到应用。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { importInternalKnowledge } from "./examples/_shared/tools/retrieval/memory.ts";
import { AnalysisAdapters } from "./examples/_shared/tools/analysis/adapters.ts";
import { createFixture, pythonPath } from "./examples/capabilities/analysis/fixtures.ts";
import { sandbox } from "./examples/capabilities/analysis/cli.ts";
import { run } from "./examples/capabilities/analysis/compare.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-analysis-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-analysis-tasks/app-"));
// 真实应用以自己的请求、文件、页面和知识库替换样例初始化。
const fixture = await createFixture(directory, "compare");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new AnalysisAdapters(directory, fixture.request, pythonPath());
    try {
      const runtime = createDitto({
        config,
        sandbox: sandbox(config, fixture.request, adapters),
        workers: [
          ...storage.workers, createInferWorker(),
          createRetrievalWorker({ providers: adapters.providers }),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      try {
        await importInternalKnowledge(runtime, fixture.request.tenant, fixture.knowledge);
        const report = await run(runtime, {
          request: fixture.request, model: { provider, model },
        });
        console.log(directory, report);
      } finally { await runtime.close(); }
    } finally { adapters.close(); }
  } finally { await storage.close(); }
} finally { await fixture.server.close(); }
```

使用 `node --env-file=.env app.ts` 运行。完整源代码见 [shared.ts](../../examples/capabilities/analysis/shared.ts)。注册工具保留已配置的模型网络权限，额外放行可信请求明确列出的页面 origin。

## 输入契约

`Request` 由应用的 `request(value)` 校验。字段包括 `id`、`tenant`、`mode`、`question`、`period`、`subjects`、`sources` 和 `allowedOrigins`。每个来源为：

```ts
{
  id: "reference",
  format: "pdf", // text | web | csv | xlsx | pdf | image | memory | external
  origin: "document", // document | web | knowledge-internal | knowledge-external
  authority: "reference", // reference | claim，由可信控制器指定
  period: "2026-Q3",
  locator: "reference.pdf",
}
```

文件 locator 为任务目录内文件名；web 为允许的 URL；memory 为当前租户的 `knowledge:<tenant>:<name>` key；external 为批准的数据库文档 ID。`origin` 必须匹配实际传输方式。模型输出不能新增来源、改租户、改参考级别或跨期间合并资料。

默认 schema 为保存天数、存储容量和支持响应小时数。若要处理其他业务字段，修改应用 `domain.ts` 中的字段/单位契约、提取提示和校验规则；Core 接口不随业务字段变化。

## 实际执行链路

1. 请求经 `MEMORY.WRITE` 归档；`CONTEXT.LOAD` 从 Redis 读取或由数据库恢复。
2. 文件/网页经过 `INTERACTION.ACT.TOOL` 读取；PDF、表格和图片分别调用真实解析工具。
3. 内部知识通过 `MEMORY.SEARCH` 的精确 key 过滤读取，核对类型和租户；外部知识经 `RETRIEVAL.SEARCH` 调用绑定的数据库 Provider。
4. 解析后的来源、定位和快照归档到 Memory，并更新 Context。
5. `INFER.REASONING.SAMPLE` 返回逐片段提取结果；应用分析工具校验引用，统一单位、去重、识别冲突、核对参考值并计算差值。
6. 报告经 Memory 提交后，输出 JSON、CSV、Markdown。

`MEMORY.*`、`RETRIEVAL.SEARCH`、模型采样均检查 `NodeResult.status` 和 `output`；工具调用检查 `ExternalResult.status` 后使用 `structuredContent`。失败不会被转换为空成功结果。来源是非可信数据，不参与工具权限或参考级别授权。

## 提取与结果契约

模型返回 `{ claims, unresolved }`。每条提取包含 `blockId`、`subject`、`field`、原始 `value`、原始 `unit` 和逐字 `quote`。每个输入片段必须恰好出现一次；无法映射时保留 `{ blockId, reason }`。模型不自行换算、不去重、不裁决可信来源。

`Report` 包含 `material`、规范化 `claims`、`unresolved`、`groups`、`duplicates`、`conflicts`、`comparison` 和 `differences`。原文位置通过 `claim.blockId` 回到 `material.blocks`，再通过 `sourceId` 找到 URI 和解析器记录；快照 SHA-256 对应保存的原始文件或数据库/Memory 记录。

去重键为对象、字段、期间和规范值。冲突键不含规范值，因此发现同一范围的不同声明。核验依赖当前对象/字段/期间的参考组：无参考为 `unverified`，一致参考相符为 `supported`，不符为 `refuted`，参考值之间冲突为 `disputed`。重复引用不增加可信度。此处核验的是与指定参考材料的一致性，并不自动证明资料真实或独立核验开放世界事实。

比较只使用请求期间的 supported 值，计算 `right - left`；unknown/disputed 及其差值均为 `null`。保留信息缺失和争议，不生成假定数值。

## 恢复与验收

`run(runtime, input, { signal?, stopAfter?: "sources" })` 支持取消和来源归档后暂停。检查点为 `analysis:<id>:request|sources|report`，Redis scope 为 `{ sessionId: "analysis:<id>" }`。缓存未命中才从数据库恢复；其他 Redis/Memory 错误直接失败。恢复不会把内部知识或任务归档当作外部资料，也不会重新抓取已提交的来源。

来源归档前失败可能重做读取，报告提交前失败可能重新推理。报告已提交时只需重试幂等文件输出。请求摘要按统一结构计算，不受 JSON 字段顺序影响；修改数据源、期间或可信规则要创建新任务 ID。应用负责同一任务的串行运行。

运行 `npm run check:examples:analysis:tasks:package` 验证仓库外 npm 消费者的公开类型、模块边界和真实完整任务。检查点恢复使用实际 SIGKILL 子进程；文件格式、OCR、HTTP、Redis、Memory 和模型均实际调用。生产页面和其他数据库的接入需要针对对应部署独立验收，样例 HTTP 发布端和 SQLite 验收不代表所有第三方服务已经测试。
