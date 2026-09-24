# 上下文任务组装 API

[English](context-workflows.md) · [Context 节点参考](context.zh-CN.md) · [五项可运行示例](../../examples/capabilities/context/README.zh-CN.md)

上下文加载、选择、组装、压缩和更新通过现有公开 `CONTEXT.LOAD / SELECT / UPDATE / COMPRESS` 与 `INFER.REASONING.SAMPLE` 组装。组装是多个来源的加载和更新；语义摘要是显式模型推理，无需额外隐式模型调用或私有入口。

## 应用调用

以下代码保存到仓库根目录的 TypeScript 文件后可运行。数据库和 Redis 适配器属于示例应用，发布 Core 包不会自动安装 Redis SDK 或提供业务工具。消费 npm 包时，将 `examples/_shared/tools/storage`、`examples/_shared/tools/context` 和 `examples/capabilities/context` 一起复制到应用，安装 Redis 依赖并配置 `ditto.yaml`。所有 Core 导入均来自已导出包入口。

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { contextTools } from "./examples/_shared/tools/context/adapters.ts";
import { createFixture } from "./examples/capabilities/context/fixtures.ts";
import { sandbox } from "./examples/capabilities/context/cli.ts";
import { seedConversation } from "./examples/capabilities/context/shared.ts";
import { run } from "./examples/capabilities/context/compress.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-context-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-context-tasks/api-"));
const fixture = await createFixture(directory, "compress");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const runtime = createDitto({
      config, sandbox: sandbox(config, fixture.request),
      workers: [...storage.workers, createInferWorker(),
        createInteractionWorker({ tools: contextTools(directory, fixture.request) })],
    });
    try {
      await seedConversation(runtime, fixture.request, fixture.turns);
      console.log(await run(runtime, { request: fixture.request, model: { provider, model } }));
    } finally { await runtime.close(); }
  } finally { await storage.close(); }
} finally { await fixture.server.close(); }
```

用 Node.js 24 运行：`node --env-file=.env your-example.ts`。示例入口与 `shared.ts` 中的辅助函数是应用代码，不是 Core 新增的包导出。

## 节点调用契约

| 能力 | Runtime 节点输入 | 输出及影响 |
| --- | --- | --- |
| 加载/恢复 | `CONTEXT.LOAD({scope,sources})` | 返回 `Context`；整体创建或替换 Redis 工作集 |
| 读取 | `CONTEXT.LOAD({scope})` | 返回 `Context`；缺失或过期抛 `CONTEXT_NOT_FOUND` |
| 选择 | `CONTEXT.SELECT({scope,purpose:"infer",query,limit,maxTokens})` | 返回 `ContextSelection`，使用 `.context` 推理；不写缓存、不延长 TTL |
| 组装 | `CONTEXT.UPDATE({scope,add,ingress})` | `add` 保留应用指定来源；`ingress` 记录 `sourceNode`、引用和元数据 |
| 更新 | `CONTEXT.UPDATE({scope,removeIds,add,expectedVersion})` | 默认重复 ID 替换；返回新 `Context`；版本不匹配抛 `STATE_CONFLICT` |
| 压缩 | `CONTEXT.COMPRESS({scope,maxItems,maxTokens})` | 裁剪并写缓存；保留受保护条目及完整 `callId` 组；不可满足预算抛 `BUDGET_UNSATISFIABLE` |
| 摘要 | `INFER.REASONING.SAMPLE({model,messages})` → 应用核验 → `CONTEXT.UPDATE` | 模型摘要不会由 `COMPRESS` 自动生成；经校验后作为新条目写入 |
| 存档/恢复 | `MEMORY.WRITE` / `MEMORY.GET` | 返回 `NodeResult`，应用检查 `status` 后读取 `.output` |

`CONTEXT.*` 返回原始 Context/Selection 并抛出 `ContextError`；不要按 `NodeResult.output` 解包。工具节点返回 `ExternalResult`，推理与 Memory 返回 `NodeResult`。预算约束同时受 Worker policy 限制；请求不能放宽全局 policy。`scope` 与显式 `context` 输入互斥。

默认压缩保护 `protected/safety/currentGoal/pending` 或 system 条目；默认选择依然可能因预算跳过它们，因此示例显式验证关键指令。摘要条目保留已核对的原始证据 URI；原始长历史继续保存在数据库会话及 base 检查点中。

## 持久化顺序

1. 从文件工具与 `MEMORY.GET` 获取受信宿主准入的输入，执行 scope Context 节点，保存 `base` 工作集。
2. 执行选择、组装、压缩或更新，保存 `ready` 工作集与推理视图。
3. 从 Redis 重新读取/选择，核对与已提交视图一致后调用模型，校验业务字段及引用，将 `report` 写入 Memory。
4. 工具将报告原子发布到文件；重复提交相同内容是幂等的，不覆盖不同内容。

每次恢复都读取数据库已提交检查点，再与 Redis 对齐。写缓存后但检查点提交前崩溃的操作可从上一个阶段重做；报告提交后不重复模型调用。不同请求不能复用任务 ID。该流程要求每任务单控制器；CAS 不提供跨服务事务或业务级任务锁。服务错误不会伪装成缓存未命中。

会话 Memory、任务检查点和内部知识库是不同命名空间。本模块读取的是会话历史；HTTP 搜索是外部来源，不会借用任务检查点冒充知识库。第三方工具实现与配置位于 `examples/_shared/tools/context/`，未加入 Core 运行时。
