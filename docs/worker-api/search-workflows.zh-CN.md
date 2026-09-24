# 信息检索与搜索：公开 API 组装

[English](search-workflows.md) · [API 索引](README.zh-CN.md) · [八个示例](../../examples/capabilities/retrieval/README.zh-CN.md)

这组流程使用已有的公开 Worker、Provider 和 Graph 接口。词表规则、正文解析、数据库索引、来源快照和报告校验放在应用工具中；无需为八项业务能力各新增一个 Core 节点。

| 公开入口 / 节点 | 用途 |
| --- | --- |
| `@codesoul-co/ditto/runtime`：`createDitto`、`graph`、`runtime.run` | 注册 Worker，执行查询规划、检索、持久化和发布图 |
| `@codesoul-co/ditto-retrieval`：`createRetrievalWorker`、`RetrievalTargetRegistry` | 将 `documents` 和 `knowledge-external` 绑定到允许的检索 Provider |
| 同上：`createTextSearchProvider`、`createSqlSearchProvider` / `RETRIEVAL.SEARCH` | 文档关键词匹配与带参数的 FTS 查询 |
| `@codesoul-co/ditto/worker/interaction`：`createWebSearchTool`、`WebSearchProvider`、`createBraveWebSearchProvider` | 搜索引擎契约和已导出的 Brave 实现 |
| 同上：`createInteractionWorker`、`RegisteredTool` / `INTERACTION.ACT.TOOL` | 执行 `web_search`、`retrieval_read_page`、`retrieval_publish_local` |
| `@codesoul-co/ditto/worker/infer`：`createInferWorker` / `INFER.REASONING.SAMPLE` | 选择查询和逐字引用 |
| `@codesoul-co/ditto/worker/context`：`createContextWorker({ redis })` / `CONTEXT.LOAD/UPDATE` | Redis 会话上下文 |
| `@codesoul-co/ditto/worker/memory`：`createMemoryWorker({ store })` / `MEMORY.GET/WRITE/SEARCH` | 内部长期知识、会话记忆与恢复检查点 |

## 完整调用

以下代码放在应用根目录。安装 `@codesoul-co/ditto` 包后，复制 `examples/capabilities/retrieval/`、`examples/_shared/tools/retrieval/`、`examples/_shared/tools/storage/` 和 `ditto.yaml` 到应用。安装 Redis 与 HTML SDK；使用仓库时直接运行[示例命令](../../examples/capabilities/retrieval/README.zh-CN.md)。

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
npm ci --prefix examples/_shared/tools/retrieval/dependencies
```

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { RetrievalAdapters } from "./examples/_shared/tools/retrieval/adapters.ts";
import { importInternalKnowledge } from "./examples/_shared/tools/retrieval/memory.ts";
import { createFixture } from "./examples/capabilities/retrieval/fixtures.ts";
import { sandbox } from "./examples/capabilities/retrieval/cli.ts";
import { run } from "./examples/capabilities/retrieval/multi-source.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-retrieval-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-retrieval-tasks/app-"));
// 用可信应用的请求、文档和知识库替换此样例初始化。
const { request, internalKnowledge } = await createFixture(directory, "multi-source", { knowledge: "both" });
const adapters = new RetrievalAdapters(directory, request);
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config,
      sandbox: sandbox(config, request, adapters),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createRetrievalWorker({ providers: adapters.providers, defaults: config.retrieval }),
        createInteractionWorker({ tools: adapters.tools }),
      ],
    });
    try {
      await importInternalKnowledge(runtime, request.tenant, internalKnowledge);
      const report = await run(runtime, { request, model: { provider, model } });
      console.log(directory, report);
    } finally { await runtime.close(); }
  } finally { await storage.close(); }
} finally { adapters.close(); }
```

使用 `node --env-file=.env app.ts` 启动。`sandbox()` 保留配置中的模型网络权限，添加可信页面 origin 和搜索引擎 origin，并限定工具名称。模型输出不会扩展来源或权限。

## 内部知识与外部知识的调用边界

`Request.knowledge` 为 `internal | external | both`。内外指知识是否由 Agent Memory 管理，与企业内外网无直接关系。外部来源示例为独立 SQLite FTS5；接入企业数据库或知识服务时替换其应用 Provider。无需将外部系统的全部资料写入 Memory 才能检索。

内部长期知识通过 [importInternalKnowledge](../../examples/_shared/tools/retrieval/memory.ts) 显式写入，记录内容为 `{ kind: "knowledge", tenant, title, text }`，key 为 `knowledge:<tenant>:<name>`。检索调用：

```ts
const recall = graph<{ key: string; query: string }>("internal-knowledge-recall")
  .node("hits", "MEMORY.SEARCH", [], input => ({
    query: input.query,
    strategy: "keyword",
    filter: { key: input.key },
    limit: 1,
  }));
// key 来自可信应用允许列表，而非模型生成。
const { hits } = await runtime.run(recall, {
  key: "knowledge:team-a:retention", query: "retention",
});
if (hits.status !== "success" || !hits.output) throw new Error("Memory search failed");
console.log(hits.output); // MemorySearchResult[]，每项包含完整 memory 记录。
```

示例对每个 `internalKnowledgeKeys` 单独执行精确过滤，校验记录类型和租户，再保存来源快照。查询适配器使用现有数据库关键词搜索；并非读取模型的参数知识。Redis Context 只承载本次任务上下文，不作为内部知识库。

外部知识使用下面的 `knowledge-external` Target。来源分别标为 `knowledge-internal` 与 `knowledge-external`；内部定位到 Memory ID/key/content.text，外部定位到数据库表/行/列。二者可同时进入报告，但不隐式改变可信度或解决矛盾。外部结果为恢复而写入任务 Memory，不代表它已被批准为长期知识。

## 单次外部检索调用

```ts
import { graph } from "@codesoul-co/ditto/runtime";
const search = graph<{ query: string; tenant: string }>("knowledge-lookup")
  .node("matches", "RETRIEVAL.SEARCH", [], input => ({
    target: { name: "knowledge-external", namespace: input.tenant },
    query: { content: input.query },
    strategy: "fts5",
    limit: 3,
  }));
const { matches } = await runtime.run(search, { query: "retention", tenant: "team-a" });
if (matches.status !== "success" || !matches.output) throw new Error("Search failed");
console.log(matches.output.candidates);
```

`RETRIEVAL.SEARCH` 返回 `NodeResult<RetrievalSearchOutput>`，必须检查 `status`。候选的 `content` 是正文，`source.ref` 是来源 URI，应用在 `metadata.evidence` 保存定位和快照信息。Provider 自己负责 SQL 方言、参数绑定、租户授权、排序和 limit；Core 不代替业务权限判断。

网页通过 `INTERACTION.ACT.TOOL` 调用 `{ call: { id, name: "retrieval_read_page", arguments: { url, query } } }`，检查返回的 `ExternalResult.status` 后读取 `structuredContent.evidence`。`web_search` 的参数为 `{ query, limit }`，结果位于 `structuredContent.results`。搜索摘要不直接成为报告证据，必须读取页面正文。

## 输入和恢复协议

`Request` 的必填字段见 [domain.ts](../../examples/_shared/tools/retrieval/domain.ts)：`id`、`tenant`、`mode`、`knowledge`、`internalKnowledgeKeys`、`question`、`query`、`vocabulary`、`documents`、`urls`、`allowedOrigins`、`searchEngine`、`allowPartial`。请求由可信控制器创建并经 `request(value)` 校验；`documents` 仅允许工作目录内的 Markdown 文件名。改写选择一个词表项，扩展选择 2–3 个不同词表项，其余模式保持固定查询。查询数与字符长度由应用校验。

`run(runtime, input, { signal?, stopAfter? })` 接受取消信号；`stopAfter` 为 `queries` 或 `evidence` 时返回 `{ status: "checkpoint", stage }`。完整执行返回 `Report`：`requestId`、`question`、`queries`、`evidence`、`findings`、`failures` 和 `status`。每条证据保留 `id/source/uri/title/text/location/snapshot/queries`；每条引用为 `{ sourceId, quote }`。

顺序为：数据库请求归档 → Redis Context → 模型查询 → 查询归档 → 真实检索 → 证据归档 → 模型摘录与校验 → 报告归档 → 本地文件发布。Memory key 为 `retrieval:<id>:request|queries|evidence|report`；Context scope 为 `{ sessionId: "retrieval:<id>" }`。缓存缺失时仅通过 `MEMORY.*` 重建，其他 Context 错误不降级。

Memory 提交是恢复边界。提交完成但 Context 更新前退出时，下一次从数据库重建；报告已提交但写文件失败时，只重试幂等文件写入。尚未提交的推理或读取允许重复执行。请求内容用摘要绑定 ID，修改请求须生成新 ID。调用方负责同一任务的串行推进和目录权限。

报告只包含通过原文校验的摘录。异常来源是否允许部分成功由 `allowPartial` 决定；无命中返回 `no-evidence`。`completed` 表示工作流完成，不表示所有事实已获得独立核验。具体限制与端到端验收命令见[示例说明](../../examples/capabilities/retrieval/README.zh-CN.md)。
