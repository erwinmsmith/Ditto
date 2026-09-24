# 联网搜索问答的公开 API 组合

[English](web-search-workflows.md) · [API 目录](README.zh-CN.md) · [完整示例](../../examples/patterns/web-search-qa/README.zh-CN.md)

`runWebQa` 和 `runWebQaLoop` 是应用示例导出。Core 提供公开的 Runtime、Loop、Graph、Worker 与 WebSearchProvider。一个主 Loop 调度全部阶段 Graph；执行计划不调用 runtime.run，也不直接执行 Worker。

## 可运行的包消费者

使用 Node.js 24+、已安装的 `@codesoul-co/ditto` 包或 tarball、Redis、文本模型，以及 `redis` / `linkedom` 依赖。复制 `examples/patterns/web-search-qa`、`examples/_shared/tools/web-search`、`examples/_shared/tools/storage`、`examples/_shared/tools/evidence.ts`、`examples/_shared/tools/execution/files.ts` 和 `examples/_shared/tools/retrieval/{web.ts,domain.ts,dependencies/package.json}`，保留相对路径。准备 ditto.yaml 和模型环境变量，设置 DITTO_WORKER_CONTEXT_REDIS_URL。将以下入口保存为应用根目录的 web-search-client.ts：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createTask } from "./examples/_shared/tools/web-search/adapters.ts";
import { searchConfig } from "./examples/_shared/tools/web-search/providers.ts";
import { defaultRequest } from "./examples/patterns/web-search-qa/fixtures.ts";
import { openWebQa } from "./examples/patterns/web-search-qa/cli.ts";
import { runWebQa } from "./examples/patterns/web-search-qa/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_WEB_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
await mkdir(".examples-web-search-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-web-search-tasks/consumer-"));
const search = searchConfig();
const request = await createTask(directory, defaultRequest(), search);
const app = await openWebQa(directory, request, config, search);
try {
  const result = await runWebQa(app.runtime, { request, model: { provider, model } }, {
    signal: AbortSignal.timeout(300_000)
  });
  if ("status" in result) throw new Error("Unexpected checkpoint");
  console.log(JSON.stringify({ directory, answer: result.answer }, null, 2));
} finally { await app.close(); }
```

运行 `node --env-file=.env web-search-client.ts`。defaultRequest 只提供公开资料演示身份；真实应用通过 createTask 传入经过认证的 tenant/principal、问题、允许访问的来源及预算。

## API 与阶段契约

| 公开 API | 用途 |
| --- | --- |
| loop / graphStep / runtime.loop | 一个计划组合不同阶段，最多执行 128 个 Graph，支持取消和运行轨迹 |
| graph().node() | 声明阶段内 Worker 节点与依赖；Graph 不嵌套子 Graph |
| CONTEXT.LOAD | Redis 工作集，scope 为 web:tenant:principal:id |
| MEMORY.GET / MEMORY.WRITE | 数据库保存请求绑定、计划、逐查询结果、网页证据、筛选结果和报告 |
| INFER.REASONING.SAMPLE | 理解与查询生成、筛选与冲突分析、答案生成、依据核验 |
| INTERACTION.ACT.TOOL | 搜索、实际网页阅读、权限/快照核对和交付 |
| createWebSearchTool({provider}) | 使用公开 WebSearchProvider；搜索摘要只用于发现来源 |

Worker 从 `@codesoul-co/ditto/worker/{context,memory,infer,interaction}` 工厂注册；编排从 `@codesoul-co/ditto/runtime` 导入。业务规则、搜索 SDK 和网页读取逻辑都位于应用工具目录，Core 不增加专用业务节点或第三方依赖。

直接调用为 `runtime.loop(runWebQaLoop, [input, options], {signal, onGraph})`；runWebQa 是便捷包装，会将 signal 传递到外层 Loop。整体取消后不再启动后续 Graph。onGraph 记录实际执行的 Graph，不代表提前穷举所有分支的静态 DAG。

## 请求、预算与返回值

Request 包含 id、tenant、principal、question、allowedOrigins、referenceUrls、maxQueries（1–3）、maxPages（1–6）、crossCheck、allowPartial。身份、网络范围、补充来源和预算由可信控制器提供，不能由模型授予。问题或策略变化须使用新任务 ID。referenceUrls 是用户明确提供的补充来源，仍须实际读取和引用，不能取代搜索。

Options.stopAfter 可选 plan、searched、read、selected、report；停止点返回 `{status:"checkpoint",stage}`。完成返回 Report，包含查询计划、筛选结果、缺失信息、冲突、网页证据、答案、失败来源、预算遗漏来源、逐结论核验和生成时间。答案状态为 answered、insufficient-evidence、conflicting-evidence、needs-clarification。

每个引用片段包含最终 URL、标题、抓取时间、原始 HTML 的 SHA256 及规范化正文段落位置。引文必须是已选中、已存档网页正文中的连续原文，不能把搜索摘要当作证据。答案需保留数字、单位、否定和适用条件；另一次真实模型调用核验结论是否被自身引文支持。答案最多修订一次，一个不中断的完整流程最多调用六次模型。无效草稿不交付，网络、模型接口和存储故障直接报错。

crossCheck=true 时，普通 answered 结论须有至少两个不同来源 origin、不同正文的引文共同支持同一个事实。镜像内容会去重。不同 origin 是可检查的佐证条件，不等同于不同编辑机构，更不能保证事实绝对正确。冲突必须展示双方原文，不任意选择胜方。失败来源和页数预算造成的遗漏会保留在报告中。

## 持久化、权限与恢复

Context 使用 Redis；示例 Memory Worker 使用文件 SQLite。HTML 和解析段落保存在快照文件中，交付文件为不可变 JSON 与 Markdown；这些文件不能替代 Memory。此场景的验收不等同于 PostgreSQL 或向量数据库验收，其他后端可通过公开 MemoryStore 注册。

只有缓存不存在或过期时，才从数据库 Memory 恢复工作集；Redis 连接失败和数据库故障不降级到内存。停止或进程崩溃后以相同请求和 Provider 重启：已完成的搜索与页面快照会复用；已有报告可幂等交付，无须再次调用模型。快照在恢复和交付前核验，已完成报告重放也重新检查权限。已有任务固定抓取版本，刷新网页需新建任务。Loop 不保存生成器调用栈。

全部搜索失败或所有正文读取失败会抛错；真实搜索成功但无结果才返回依据不足。allowPartial=true 可以保留可用来源并记录失败，不能把全部网络失败伪装成成功的空答案。预算超限、权限撤销、快照篡改、请求变更和无法核验的答案均明确失败。

详见[第三方工具配置](../../examples/_shared/tools/web-search/README.zh-CN.md)和[Loop API](graph-loops.zh-CN.md)。
