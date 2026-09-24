# 长期记忆与任务状态 API

[English](memory-workflows.md) · [Memory 节点契约](memory.zh-CN.md) · [完整示例](../../examples/capabilities/memory/README.zh-CN.md)

四种记忆能力共用公开 `MemoryStore` / `MemorySearchProvider` 与 Runtime Graph。更换关系型或向量数据库只更换应用适配器，不从源码或未导出路径调用 Worker，也不为某个数据库增加专用 Core 节点。

## 最小完整调用

以下示例在仓库根目录保存为 TypeScript 文件，以 `node --env-file=.env your-example.ts` 运行。需要 Node.js 24、真实模型、Redis 和所选数据库。消费 npm 包时，将示例的 memory 目录与共享 memory/storage 工具复制到应用，安装应用侧 Redis/pg 依赖；这些文件不是 Core 的包导出。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openMemoryStorage } from "./examples/_shared/tools/memory/storage.ts";
import { memoryTools } from "./examples/_shared/tools/memory/adapters.ts";
import { namespace, type Backend } from "./examples/_shared/tools/memory/domain.ts";
import { createFixture } from "./examples/capabilities/memory/fixtures.ts";
import { sandbox } from "./examples/capabilities/memory/cli.ts";
import { writeMemories } from "./examples/capabilities/memory/shared.ts";
import { run } from "./examples/capabilities/memory/update.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
const backend: Backend = "sqlite"; // "postgres" or "qdrant" uses the same workflow.
await mkdir(".examples-memory-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-memory-tasks/api-"));
const fixture = await createFixture(directory, "update", backend);
const storage = await openMemoryStorage({
  directory, backend, namespace: namespace(fixture.request), config,
});
try {
  const runtime = createDitto({
    config, sandbox: sandbox(config),
    workers: [...storage.workers, createInferWorker(),
      createInteractionWorker({ tools: memoryTools(directory, namespace(fixture.request)) })],
  });
  try {
    await writeMemories(runtime, fixture.memories);
    console.log(await run(runtime, { request: fixture.request, model: { provider, model } }));
  } finally { await runtime.close(); }
} finally { await storage.close(); }
```

`createFixture` 只用于生成可重复的输入。接入业务时使用真实用户确认的偏好、已认证的 namespace 和项目文件；后续任务复用相同用户数据库。`run` 支持 `{signal,stopAfter:"progress"}`；完成返回报告，暂停返回 `{status:"checkpoint"}`。

## Core 接线与节点

```ts
import { createMemoryWorker } from "@ditto/core/worker/memory";
// databaseStore implements MemoryStore and optionally native MemorySearchProvider.
const worker = createMemoryWorker({
  store: databaseStore,
  // search: separateSearchProvider, // optional override
  concurrency: 1,
});
```

| 能力 | 节点输入 | 行为 |
| --- | --- | --- |
| 长期检索 | `MEMORY.SEARCH({query,strategy,filter,limit})` | 返回 `{memory,score?}[]`；SQL 用 `keyword`，Qdrant 用 `vector` |
| 精确读取/恢复 | `MEMORY.GET({ids?,keys?})` | 返回已存在记录；缺失记录不伪造空值 |
| 分页查询 | `MEMORY.QUERY({filter,limit,cursor?,orderBy?})` | 返回 `{items,nextCursor?}`；本例支持 ID 升序 |
| 规则写入 | `MEMORY.WRITE({memories:[{key,content,metadata}]})` | 应用先验证授权和证据；适配器处理相同 key 的幂等重试与冲突 |
| 修改/补充 | `MEMORY.UPDATE({memories:[{id,content?,metadata?}]})` | 按 ID 更新；缺失目标失败；未提供字段保留，提供的 metadata 整体替换 |
| 删除 | `MEMORY.DELETE({ids})` | 返回本次实际删除的 ID；作用域适配器阻止跨用户操作 |
| 阶段保存 | `MEMORY.WRITE` 保存独立 checkpoint key | 检查点携带规范化请求指纹、阶段及中间结果，恢复时校验请求身份 |

Memory 节点返回 `NodeResult`。必须先检查 `status === "success"`，再读取 `.output`；数据库错误以失败结果返回，不能将其视为“没有记忆”。Context 节点则返回原始 Context 并抛 `ContextError`。

本例 SQL 与 Qdrant 适配器支持字符串过滤字段 `key / namespace / kind`。查询策略是后端能力，Core 不承诺所有数据库共享同一种过滤语言。`scopedMemory` 强制加入可信 namespace，拒绝越界 key、过滤条件和 metadata，并在 ID 更新前核对归属。

## 关系型与向量数据库

`openSqliteMemory(path)` 使用文件 SQLite 和事务；`openPostgresMemory(url,table)` 使用参数化 PostgreSQL 查询、事务及唯一 key。通用 SQL 适配器保留 MySQL 方言扩展，但本任务套件验证的是 SQLite/PostgreSQL。

`openQdrantMemory({url,collection,dimensions,embedding,embeddingIdentity,apiKey?})` 同时实现记录存储与向量搜索：

- 长期偏好的 `content.text` 经公开 `embedContents` 调用注入的 EmbeddingProvider，写入具名 `text` 向量；查询文本用同一模型生成向量，交给 Qdrant `/points/query` 执行 Cosine 检索。
- `UPDATE` 将新 payload 和重新生成的向量一起 upsert，等待数据库确认；读取 ID/key 不依赖 embedding。
- 检查点保留完整 payload，`vector:{}`，不生成没有语义价值的假向量，也不参与偏好召回。
- key 映射到稳定 UUID。重复写入前核对完整记录；不同内容必须使用 UPDATE。多写者环境仍需宿主锁，稳定 ID 不等于并发唯一性事务。
- collection 的 schema manifest 记录 embedding 身份、维度、预处理版本与距离类型。已有库身份不匹配时拒绝打开，不默默混用向量。

Qdrant 写入采用官方的 [`wait=true` 完成确认](https://qdrant.tech/documentation/manage-data/points/)，分页采用 [scroll/offset 接口](https://api.qdrant.tech/api-reference/points/scroll-points)。这些后端细节位于应用工具中，Core 不内置数据库 HTTP 路由或 SDK。

环境配置见 `.env.example` 和 [存储说明](../../examples/_shared/tools/storage/README.zh-CN.md)。embedding 模型、维度、地址与 API key 必须成套配置；向量数据库支持不代表已有文本会自动被向量化，适配器必须明确接入 embedding。

## 持久化协议

1. 读取真实项目文件和相关长期记忆，提交 `base`。
2. 需要写入/更新时，模型提出候选；应用校验证据与保存许可，提交 `candidate`。随后读取当前记忆：操作 ID 和内容相同则认定已生效；否则在基线仍匹配时执行 WRITE/UPDATE。
3. 提交 `progress`，内容包括进展、使用的记忆快照及请求指纹。暂停或 Redis 过期后从它恢复。
4. 使用恢复后的 Redis Context 调用模型，校验报告与偏好/进展一致，提交 `report`，再发布文件。

记忆修改与检查点之间没有跨数据库事务；提交前崩溃可能重新执行尚未提交的模型步骤，修改后崩溃通过实际记录核对避免重复生效。已提交报告不重复推理。单个长期任务使用提交时的记忆快照保持结果可恢复；新任务重新检索最新长期记忆。宿主需保证每用户/任务单写控制器，处理并发与授权。
