# Reflection / Self-Refine 工作流

由单一主 Loop 通过公开 Worker 节点组合生成、核对、模型检查、修改和复查。示例从真实 CSV 生成月度经营分析，包含净收入计算、原文引用、解释边界及后续建议；也可从用户已有初稿进入检查阶段。应用定义业务规则和产物工具，Core 提供 Graph、Loop、Infer、Interaction、Context 和 Memory，无需读取源码或新增专用 Core 接口。

## 可运行调用

复制 `examples/patterns/reflection`、`examples/_shared/tools/reflection`、`examples/_shared/tools/storage`、`examples/_shared/tools/evidence.ts` 和 `examples/_shared/tools/execution/files.ts` 到消费者项目。安装 Core tarball 及 `storage/dependencies/package.json` 声明的 Redis 依赖。使用 Node 24、`ditto.yaml`、环境变量中的模型凭据和真实 Redis（`DITTO_WORKER_CONTEXT_REDIS_URL`）。下列代码放在消费者根目录；需要保留产物时使用固定目录并移除外层清理。

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createDemo } from "./examples/_shared/tools/reflection/adapters.ts";
import { openReflection } from "./examples/patterns/reflection/cli.ts";
import { runReflection } from "./examples/patterns/reflection/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_REFLECTION_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-reflection-example-"));
try {
  const request = await createDemo(directory, "flawed-draft");
  const app = await openReflection(directory, request, config);
  try {
    const result = await runReflection(app.runtime, {
      request,
      model: { provider, model },
      // Optional: reviewModel: { provider: "another-configured-provider", model: "..." }
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## 阶段契约与 API

| 阶段 | 公开节点/API | 契约 |
| --- | --- | --- |
| 加载/恢复 | `MEMORY.GET`、`CONTEXT.LOAD`、`INTERACTION.ACT.TOOL` | 不可变请求、CSV 和可选初稿指纹 |
| 生成/修改 | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | 完整结构化草稿；修改时收到上一版及全部反馈 |
| 确定性核对 | `reflection_check` 工具 | 重算净收入和增长率，检查原文引用及必要字段 |
| 主动检查 | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | 绑定草稿版本的通过、修改或人工处理结论，附具体问题 |
| 保存 | `MEMORY.WRITE` / `MEMORY.UPDATE`、产物工具 | 持久化预算、模型响应、草稿、审阅意见和核对依据 |
| 交付 | `reflection_publish` 工具 | 两类检查均通过才生成 `output/analysis.json` |

`runReflection(runtime,input,options)` 通过一次 `runtime.loop` 调用执行 `runReflectionLoop`。生成器辅助函数使用 `yield* graphStep` 向同一 Loop 提交阶段 Graph，共享 1024 次 Graph 调度预算。Graph 内仅有 Worker 节点；计划不直接进行工具、文件、网络或数据库 I/O。`Input.model` 用于生成和修改；可选 `Input.reviewModel` 使用其他已配置模型审阅。默认是同一模型在不同调用和上下文中生成、检查，不是独立外部验证。这些入口是示例应用导出，不是新增 Core 包接口。

请求固定租户、操作人、目标、CSV 指纹、可选初稿指纹、最大版本数、模型调用数和时限。草稿包含标题、净收入指标、分析解释、局限、带负责角色的建议及原文引用。本业务样例固定比较七月和八月。检查结果包含精确 `draftId`、结论和 `{field,message}` 问题；通过时问题必须为空，修改/人工处理必须给出具体依据。版本不符或格式错误显式停止。模型负责语义和质量判断，不能覆盖确定性校验错误。

CSV 的收入/退款为 120000/6000 分及 150000/9000 分，工具核对净收入为 114000、141000 分，增长率为 23.68%。`flawed-draft` 提供真实初稿文件，其中有错误指标、无依据的营销因果解释，以及缺失引用、局限和建议；检查模型发现问题后，修改模型返回完整新版本，再进行两类复查。它是已有用户初稿，不宣称这些错误由模型生成。`generate` 从真实模型生成开始，第一版满足要求即可结束，不强制制造修改。`missing-data` 因不足两个期间而在生成前请求补充资料。

## 完成、恢复和产物

- 完成要求检查结果绑定精确草稿哈希、结论为通过、模型问题为空、工具校验问题为空。发布重新读取草稿、来源指纹、检查文件与校验证据；篡改或产物冲突显式失败。
- 提示将来源和草稿视作数据，要求避免无依据因果与预测。工具验证算术、原文行和必要结构；语义审阅仍是模型判断，不等于证明每一句内容都真实。重要用途可以继续接人工审核流程。
- Context 使用真实 Redis，Memory 使用持久化 SQLite。仅缓存未命中时从 Memory 重建，存储故障不静默降级。来源或请求改变须创建新任务。本例业务输入是实际 CSV，输出是不可变文件，不另外建立业务数据库。
- 每次模型调用前持久化预留计数；重启与修改沿用原预算和起始时间。崩溃可能消耗一次调用但未保存响应。`maxRounds` 计算草稿版本数（含用户初稿），`maxModelCalls` 计算生成、检查、修改的实际尝试；工具调用由共享 Graph 预算限制。
- 通过、人工升级、缺少资料、版本/调用/时限限制、非法输出或修订内容完全相同（`no-progress`）都会停止。部分结果保留草稿 ID 和已完成检查记录，不生成已接受分析。时限包含暂停时间并阻止新模型调用入场；AbortSignal 用于取消当前运行。
- `stopAfter: "draft" | "review" | "report"` 返回检查点。恢复时使用同一目录和请求，省略 `stopAfter`；每个目录仅一个活动执行者。完成结果重放不增加模型调用，不可变发布支持重试。
- 产物包括 `drafts/<hash>.json`、`checks/<hash>.json`、`reviews/<version>.json`、`output/report.json` 和 `output/report.md`；只有完成才生成 `output/analysis.json`。Markdown 包含分析、局限、建议、来源与版本历史；建议不会被自动执行，也不会发送消息。

可信控制器创建 `request.json` 和 `policy.json`，每个工具核对身份和策略；本地策略文件展示接入边界，不充当认证系统。部署时保护任务目录并注入已认证身份。其他 Memory 数据库可通过公开 `MemoryStore` 注入；SQLite 验收不代表 PostgreSQL/MySQL 已通过。

## 适配与验收

用于内容生成时替换草稿契约与评价规则；用于代码生成时，注册应用工具，在合适沙箱运行测试，并将真实诊断传给下一轮修改；用于其他报告或推理任务时补充领域证据与核验器。工具保持在 Core 之外，本例不宣称已经执行生成代码或提供通用数学证明检查。

`npm run check:examples:reflection:package -- --provider deepseek` 在仓库外安装实际 tarball，检查无 paths 别名的严格类型、公开导入边界和静默导入，执行完整任务及上方调用代码。用例覆盖新生成、初稿修订、模型误判通过、不收敛、非法输出、预算与时限、资料缺失、Redis 过期/不可用、Memory 故障、身份/来源变化、产物篡改、取消、进程强杀和发布重试。模型输出替换与取消属于明确标记的故障注入；正常生成和初稿修订使用真实模型输出。
