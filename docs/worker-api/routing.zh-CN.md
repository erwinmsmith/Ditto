# 条件与路由：公开 API 组合

[English](routing.md) · [Runtime API](runtime.zh-CN.md) · [六类示例](../../examples/control-flow/routing/README.zh-CN.md)

路由属于应用编排。Graph 是静态 DAG，没有隐式条件边；应用用普通条件判断选择 `runtime.run(plan, input)` 的 plan。多个分支汇合时，在下游 `.node()` 的 dependencies 中列出全部上游 ID。跨轮状态选图也可使用 `loop({ graph: state => plan, bind, update, done, maxIterations })`。

## 使用的公开入口

| 入口 | API | 职责 |
| --- | --- | --- |
| `@ditto/core/runtime` | `graph<I>(id)`、`.node(id, node, dependencies, bind)` | 定义静态依赖和输入映射；bind 只读取声明的依赖输出 |
| `@ditto/core/runtime` | `createDitto`、`runtime.run`、`runtime.close` | 注册 Worker、执行选定图、关闭资源 |
| `@ditto/core/runtime` | `loadRuntimeConfigFile(path, env)` | 显式加载 YAML 与环境变量；不隐式读取 `.env` |
| `@ditto/core/worker/infer` | `createInferWorker`、`ModelConfig`、`NodeResult<SampleOutput>` | 真实模型推理及结束状态、用量 |
| `@ditto/core/worker/interaction` | `createInteractionWorker`、`RegisteredTool`、`OutputSink` | 应用工具、最终输出与回执 |

`runStateRouting` 等函数是示例应用代码，不是 `@ditto/core` 的包导出。npm 包提供 Runtime 和 Worker；将需要的示例及其相对导入文件复制到自己的应用中使用。示例中的 `shared.ts` 不是通用路由框架。

## 从应用调用

在应用安装所需版本的 `@ditto/core`，复制 `examples/control-flow/routing/` 和 `examples/_shared/tools/`，保留相对路径；准备自己的 `ditto.yaml` 与环境变量。以下 `app.ts` 位于应用根目录：

```ts
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { runRisk } from "./examples/control-flow/routing/risk.ts";
import { createPickupTool, type PickupRecord } from "./examples/_shared/tools/pickup-ledger.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure a default model");
const ledger = new Map<string, PickupRecord>();
const tools = [createPickupTool(ledger)];
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) },
  workers: [createInferWorker(), createInteractionWorker({ tools, output: {
    async deliver(input) {
      console.log(input.message.content);
      return { deliveryId: input.deliveryId, status: "accepted" };
    },
  } })],
});
try {
  const result = await runRisk(runtime, {
    id: "request-731", model: config.model,
    text: "Pickup code PICKUP-731; quantity 3.", risk: 30,
    verify: value => value.code === "PICKUP-731" && value.quantity === 3,
  });
  console.log(result.content.status, result.toolCalls);
} finally { await runtime.close(); }
```

Node.js 24+ 执行 `node --env-file=.env app.ts`。TypeScript 应用使用 NodeNext 模块解析；这些示例不需要指向仓库 `src` 的 paths 别名。未使用工具时不必注册 `record_pickup`。配置中的 Sandbox 权限由显式 `sandbox` 参数替换，添加工具权限时使用展开配置保留已设置的网络白名单。

## 路由函数契约

所有输入包含 `id`、`model`，除文件路由外均包含非空 `text`。函数接受 `Pick<DittoRuntime, "run">`，不会创建或关闭调用方 Runtime。

| 函数 | 额外输入 | 输出语义 |
| --- | --- | --- |
| `runStateRouting` | `task: extract \| count`、`state: ready \| blocked` | 阻塞状态仅交付通知，samples 为空；其他路径调用一个模型 |
| `runConditional` | 无 | 决策与选中分支各一次模型调用；未知决策抛错 |
| `runBranchMerge` | 文本包含 owner 和 deadline | 两个模型节点可并行；一个依赖两者的 OUTPUT 节点；不存在的日历日期拒绝 |
| `runFileTask` | `file: { path, name, mediaType }` | 选取真实解析工具，调用 TOOL 后进入模型处理与交付；额外返回 parsed |
| `runFileType` | `file: ParsedFile` | 应用已有解析结果时直接调用类型专用模型图 |
| `runRisk` | `risk: number`、`verify(value)` | 可信策略控制工具是否执行；返回实际 toolCalls，pending 不执行工具 |
| `runConfidence` | `evidence: string`、`assess(value, attempt)` | 一个初始模型调用，至多一个补救调用；最终分值不足则 pending_human |

通用返回 `{ content, samples, receipt }`。模型结果验证失败会抛错；INTERACTION 工具的失败对象需检查自身 status，不使用 `NodeResult` 包装。最终回执必须 accepted。异常不会自动回滚已完成的外部副作用。

分支汇合 `.node("merged", "INTERACTION.OUTPUT", ["owner", "deadline"], bind)` 在两者完成后才能调度。独立节点的并发量受 `runtime.run(..., { concurrency })` 和 Worker 容量限制。返回业务失败对象不会自动中断 Graph，因此 bind 中校验两个模型结果后才能构造交付内容。

具体阈值、文件解析边界、工具注入、真实模型及 npm tarball 验证命令见[示例说明](../../examples/control-flow/routing/README.zh-CN.md)。持久化人工任务、审批授权和第三方文件解析器由应用接入，不由这些路由函数隐式提供。

## 原始文件工具与任务交付

[文件采集工具配置](../../examples/_shared/tools/file-ingestion/README.zh-CN.md)提供 Poppler、CSV/openpyxl、Tesseract 与 faster-whisper 的实现、Python 依赖锁定和独立环境变量。它们注册为 INTERACTION 的普通工具，不增加 Core 节点或第三方依赖。

```ts
import { runFileTask } from "./examples/control-flow/routing/file-type.ts";

// runtime 已注册 createFileTools(config) 与 createInferWorker()，并设置 OutputSink。
const result = await runFileTask(runtime, {
  id: "document-731", model,
  file: { path: "/app/uploads/pickup.pdf", name: "pickup.pdf", mediaType: "application/pdf" },
});
console.log(result.parsed, result.receipt.artifacts);
```

适配器返回 name/mediaType、解析内容、sourceSha256 和 engine。文件名/MIME 与请求不符、内容无效或工具失败时不会调用模型；模型结果无效时不会交付成功产物。

应用侧 [PickupTaskStore](../../examples/_shared/tools/pickup-task-store.ts) 供本地任务实验使用：

| 方法 / 属性 | 调用用途 |
| --- | --- |
| `new PickupTaskStore(directory)` | 打开已有目录下的 tasks.sqlite；创建本地任务、业务与审批表 |
| `create(id, kind, risk?)` | 登记唯一任务；risk 来自可信业务策略 |
| `addReference(value)` / `verify(value)` | 登记业务参考记录，并核验模型提取结果 |
| `tool` / `output` | 注入 createInteractionWorker 的持久登记工具与文件 OutputSink |
| `task(id)` / `pickup(id)` | 读取持久任务状态与实际业务记录 |
| `await review(id, decision, actor)` | 应用提交 approve/reject；绑定待处理记录的内容摘要，并保存审批记录 |
| `authorized(id, value)` | 校验已批准的具体内容，拒绝修改后的参数 |
| `await fail(id, code)` | 保存失败状态与失败交付产物 |
| `close()` | 关闭应用拥有的 SQLite 连接；Runtime.close 不代为关闭 |

批准后调用 `resumeRisk(runtime, { id, value, route, authorize })`。authorize 是可信应用回调，必须严格返回 true；示例绑定 `store.authorized`，登记工具会再次核验持久策略。它恢复具体操作而不再次让模型改变已批准内容。成功交付与实际登记分别检查，不把 pending、approved 或 rejected 当作 completed。

`npm run check:examples:routing:tasks:package` 使用安装包、真实输入文件和工具、HTTP 模型、实际 SQLite 写入和文件交付完成任务验收。测试批准与拒绝由自动验收者提交；这验证审批接口链路，不表示实际有人参与。详细案例和产物位置见[任务实验](../../examples/control-flow/routing/README.zh-CN.md#任务级端到端实验)。
