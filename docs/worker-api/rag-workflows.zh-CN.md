# RAG 问答应用的公开 API 组合

[English](rag-workflows.md) · [API 目录](README.zh-CN.md) · [完整示例](../../examples/patterns/rag-qa/README.zh-CN.md)

`runRag` 是应用示例函数，不是新增的 `@ditto/core` 导出。Core 提供公开 Runtime、Graph、Worker 和检索 Provider 接口；资料格式、授权规则、任务状态机、提示词、引用校验及输出属于应用。

## 可运行的消费者入口

使用 Node.js 24+。先安装 `@ditto/core` 发布包（发布前可安装 `npm pack` 产出的 tarball），并复制 `examples/patterns/rag-qa`、`examples/_shared/tools/rag`、`examples/_shared/tools/storage` 和 `examples/_shared/tools/execution/files.ts`、`examples/_shared/tools/evidence.ts` 到应用的同名路径。安装 storage 的依赖，准备 `ditto.yaml` 和模型环境变量，设置 `DITTO_WORKER_CONTEXT_REDIS_URL`。下列入口放在应用根目录，保存为 `rag-client.ts`：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { runRag } from "./examples/patterns/rag-qa/index.ts";
import { openRag } from "./examples/patterns/rag-qa/cli.ts";
import { createFixture, seedInternalKnowledge } from "./examples/patterns/rag-qa/fixtures.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_RAG_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-rag-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-rag-tasks/consumer-"));
const request = await createFixture(directory);
const app = await openRag(directory, request, config);
try {
  await seedInternalKnowledge(app.runtime); // trusted controller ingestion
  const result = await runRag(app.runtime, {
    request,
    model: { provider, model },
  }, { signal: AbortSignal.timeout(180_000) });
  if ("status" in result) throw new Error("Unexpected checkpoint");
  console.log(JSON.stringify({ directory, answer: result.answer }, null, 2));
} finally {
  await app.close();
}
```

```sh
node --env-file=.env rag-client.ts
```

`createFixture` 只用于构造演示素材。自有应用使用可信来源目录和认证后的请求；不用演示素材时也不需要 `seedInternalKnowledge`。如果使用内部知识，写入应由可信资料接入控制器执行。

## Runtime 注册与执行边界

`openRag()` 的组合：

| 公开入口 | 注册的能力 | 本例用途 |
| --- | --- | --- |
| `createDitto`, `graph`, `loop`, `graphStep`，来自 `@ditto/core/runtime` | Runtime / 图节点依赖 | `runRag()` 调用一次 `runtime.loop(runRagLoop, ...)`；计划交出各阶段 Graph |
| `createContextWorker` | `CONTEXT.LOAD`, `CONTEXT.UPDATE` | Redis 工作集加载与组装 |
| `createMemoryWorker` | `MEMORY.GET`, `MEMORY.WRITE` | 获准的内部知识、持久化检查点 |
| `createRetrievalWorker` | `RETRIEVAL.SEARCH` | 已授权且有版本的文本索引 |
| `createInferWorker` | `INFER.REASONING.SAMPLE` | 理解、筛选、回答、依据检查 |
| `createInteractionWorker` | `INTERACTION.ACT.TOOL` | 来源授权、接入、快照检查和输出 |

Worker 工厂分别从 `@ditto/core/worker/context`、`memory`、`retrieval`、`infer`、`interaction` 子路径导出。应用不调用 `.instantiate()` / `.execute()`，也不通过源码或构建目录导入。

检索后端经公开 `RetrievalTargetRegistry` 和 `createTextSearchProvider` 注入：目标名 `rag-corpus`，策略 `bm25`，namespace 为 `<tenant>:<principal>:<requestId>`。Provider 的数据库操作属于应用适配器；图中只出现公开 `RETRIEVAL.SEARCH`。

内部 Memory 知识先通过 `MEMORY.GET` 读取明确允许的 key，再按实际文本进入 FTS 索引；因此查询重写和全文排序与用户文档一致。外部知识读取独立业务数据库，不经过 Memory。不要把任务检查点伪装成可检索知识。

## 请求与返回值

```ts
interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  sourceIds: string[];
}
interface Options {
  signal?: AbortSignal;
  stopAfter?: "indexed" | "retrieved" | "selected" | "report";
}
```

身份来自宿主认证上下文，来源目录由可信控制器维护。`openRag` 与 `runRag` 绑定同一个规范化请求。请求内容改变时必须换 ID；不能用原 ID 覆盖已有问题。

完整返回 `Report`：

- `plan`：意图、查询、所需事实及澄清问题。
- `selection`：所选片段 ID、缺失事实及互相矛盾的片段组。
- `evidence`：来源类别、标题、URI、完整快照 hash、行范围和文本。
- `answer`：状态、结论列表和限制说明；结论引用绑定原文。
- `trace`：阶段及其结果摘要；不包含模型隐藏推理。
- `grounding`：`model-checked` 或 `no-claims`，不代表人工审核。

停止点返回 `{status:"checkpoint", stage}`。资料或存储故障、超限、无效模型输出、无效引用、依据检查失败均抛出错误；不会伪装成业务成功状态。外部服务错误细节可通过 Runtime 观测接口记录，避免把数据库连接信息暴露给终端用户。

## 内部知识接入调用

可信控制器可以复用以下公开节点，将审批后的资料写入 Memory：

```ts
import { graph } from "@ditto/core/runtime";
const ingest = graph("approved-knowledge").node("saved", "MEMORY.WRITE", [], () => ({
  memories: [{
    key: "knowledge:demo:maintenance",
    content: {
      kind: "knowledge", tenant: "demo", title: "内部知识库维护规范",
      text: "内部知识库每周三由资料管理员检查。"
    }
  }]
}));
const output = await runtime.run(ingest, {});
if (output.saved.status !== "success") throw new Error("Knowledge write failed");
```

同 key 不同内容不能当作幂等写入；知识更新使用公开 `MEMORY.UPDATE`，然后创建新 RAG 任务重新接入。示例固定初次索引快照，不在恢复阶段自动更新原文。

## 模块职责与扩展

- `index.ts`：完整状态机、公开节点组装、模型指令及检查点恢复。
- `cli.ts`：显式配置、资源连接和关闭、命令行取消信号。
- `fixtures.ts`：演示控制器创建资料、导入经批准的知识。
- `tools/rag/domain.ts`：请求、预算、分块、引用和结果契约。
- `tools/rag/adapters.ts`：文件、业务 SQLite、FTS、原文快照、发布工具。

切换企业知识系统或向量库时替换 Provider / 接入工具，保留授权、来源定位和快照契约。Embedding、混合检索、重排可用既有公开接口组合；这个运行版本采用真实 SQLite FTS5，并未声称完成这些替代后端的端到端验收。

宿主负责认证、任务并发锁、密钥配置、日志脱敏、文档及产物保留策略。一个目录用于一个任务执行者。模型不会获得数据库凭据或可执行操作权限。

## 包消费者验收

`npm run check:examples:rag:package -- --provider deepseek` 在仓库外安装真实 tarball，无 `paths` 别名，并对解析后的模块路径强制执行公开入口规则。完整任务使用真实模型、Redis、Memory SQLite、业务 SQLite、FTS 索引及文件产物。模块导入检查不产生任务、网络请求或文件写入。

[通过 Loop 组合 Graph](graph-loops.zh-CN.md)
