# 多候选生成、评估与选择

单一主 Loop 先生成一组不同角度的产品文案，逐个独立评估，再选择最优候选或组合合格字段并重新评估。Graph 使用公开 Worker 节点，候选契约、业务校验与产物属于应用层；无需新增专用 Core 接口或读取源码。

## 可运行调用

复制 `examples/patterns/candidate-selection`、`examples/_shared/tools/candidates`、`examples/_shared/tools/storage`、`examples/_shared/tools/evidence.ts` 和 `examples/_shared/tools/execution/files.ts` 到消费者项目。安装 Core tarball 及 `storage/dependencies/package.json` 声明的 Redis 依赖。使用 Node 24、已配置的 `ditto.yaml`、环境变量中的模型凭据，以及真实 Redis（`DITTO_WORKER_CONTEXT_REDIS_URL`）。下列文件放在消费者根目录；需要保留产物时使用固定目录并移除外层清理。

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createDemo } from "./examples/_shared/tools/candidates/adapters.ts";
import { openCandidates } from "./examples/patterns/candidate-selection/cli.ts";
import { runCandidates } from "./examples/patterns/candidate-selection/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = process.env.EXAMPLE_CANDIDATES_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-candidates-example-"));
try {
  const request = await createDemo(directory, { mode: "fuse" });
  const app = await openCandidates(directory, request, config);
  try {
    const result = await runCandidates(app.runtime, {
      request,
      model: { provider, model },
      // Optional: evaluationModel: { provider: "another-configured-provider", model: "..." }
    });
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

接入自己的资料时使用应用函数 `createTask(directory,input,catalog)`，其中 `input` 为 `Omit<Request,"sourceDigest">`，`catalog` 为 `{product,cta,facts:[{id,text}]}`。函数校验并计算资料指纹，保存不可变请求、资料及本地权限文件。身份、限制、权限和回退策略来自可信控制器。`createDemo` 提供 Orbit 示例资料：离线编辑、Markdown 导出及团队版共享工作区，不接入或宣传真实商业服务。

## API 与阶段契约

| 阶段 | 公开节点/API | 契约 |
| --- | --- | --- |
| 加载/恢复 | `MEMORY.GET`、`CONTEXT.LOAD`、`INTERACTION.ACT.TOOL` | 不可变请求、资料哈希和已持久化预算 |
| 生成候选组 | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE` | 2–4 次独立生成，分别强调价值、使用过程、克制可信、简洁表达 |
| 筛查 | `candidates_save` 工具与业务规则 | 指定 CTA、受支持事实、逐字事实引用和字数限制；归一化文本去重 |
| 独立评估 | Context → Infer、`candidates_grade` | 每个格式合法且不重复的候选使用独立评价上下文，评分绑定候选哈希 |
| 选择 | Loop 对已保存评价进行纯计算 | 合格候选按加权分降序，同分按哈希稳定排序 |
| 融合 | Context → Infer、`candidates_save` | 选择合格父候选字段 ID，由控制器原样组合 |
| 融合复评 | Context → Infer、`candidates_grade` | 对新结果重新执行全部校验和模型评价 |
| 输出 | `candidates_publish` | 重查排名、文件哈希、来源和组合关系，生成文案与审计报告 |

`runCandidates(runtime,input,options)` 仅调用一次 `runtime.loop` 执行 `runCandidatesLoop`。生成器辅助函数通过 `yield* graphStep` 向同一 Loop 提交 Graph，共享 1024 次 Graph 调度预算。Graph 不嵌套 Graph/Loop；计划不直接操作文件、数据库、网络或 Worker。生成按顺序进行，后续候选可避开已有表达；评价使用独立上下文，不读取其他候选的评分。这是多候选生成示例，不是并行执行示例。可选 `Input.evaluationModel` 指定其他已配置模型；默认同一模型分次调用，不视为独立外部验证。上述函数是示例应用导出，不是额外 Core 包接口。

## 校验与排名

候选结构为 `{headline,body,cta,factIds}`。标题不超过 40 个 Unicode 码点，正文不超过 160 个；正文逐字包含至少两条资料事实，引用 ID 不重复且存在，CTA 与资料完全一致。候选格式错误、硬性校验失败或评价无效时，记录淘汰原因并继续其他候选。归一化重复文本（NFKC、转小写、去空白及标点）不重复评价。不同角度和文本去重用于促进多样性，不保证语义创新。

评价绑定精确候选哈希，包含通过/淘汰结论、0–5 整数评分、公开理由和问题。总分为 `清晰度 × 2 + 受众匹配 × 2 + 可信度`，满分 25。只有硬性校验通过、模型评价通过且问题为空、达到 `minScore` 的候选才可入选。错误 ID、越界分数及矛盾结论会被排除。评分是规则下的模型判断，不是概率或市场效果证据。硬性检查核对事实引用与结构要求，其他文本的语义可信度仍由模型评估，不是形式化真实性证明。

至少一个合格候选即可选择；报告保留被淘汰项，不宣称所有候选均通过。没有合格候选或资料不足时返回 `needs-human`，不输出已接受文案。同分按候选哈希排序，恢复时使用原评价。被选中的候选原文保持不变。

## 融合与回退

融合使用前两名合格候选。模型返回 `{headlineFrom,bodyFrom,ctaFrom,reason}`，填写精确父候选 ID；标题与正文必须来自不同候选。控制器原样复制字段，事实 ID 沿用正文来源。与已有候选内容相同的组合会被拒绝。该示例采用有来源依据的字段组合，不自由编造新事实。

组合结果是新候选，必须重新通过工具校验和模型评价，不能继承父候选评分。组合非法、复评不通过或不足两个合格父候选时，`allowFallback: true` 才允许回退到最高分原候选，并明确记录 `applied: fallback`；禁用回退则交由人工处理。预算或时限耗尽返回 `partial`，不静默回退或交付已接受文案。

## 持久化与产物

- Context 使用真实 Redis，Memory 使用持久化 SQLite；仅缓存不存在时重建，存储故障不静默切换内存。请求或资料变更须新建任务。本例业务资料与产物为真实文件，不是另一个 Memory 后端。
- 每次模型调用前持久化预留计数和原始起始时间，覆盖生成、评价、融合与复评，跨重启沿用。崩溃可能消耗一次计数但没有响应；时限包含暂停时间并阻止新模型调用入场，AbortSignal 用于取消正在运行的任务。
- `stopAfter` 支持 `candidate|assessment|fusion|report`。恢复时使用同一目录与请求，去掉检查点选项；每个任务目录只允许一个活动执行者。产物不可变，重复发布不重新生成或评分。
- `candidates/<hash>.json` 和 `grades/<hash>.json` 保存内容与评价依据；`output/report.json`、`output/report.md` 保存候选结果、排名、回退原因及融合来源。仅完成时生成 `output/copy.json` 和 `output/copy.md`。这里的发布指写入本地文件，不发布营销内容到外部平台或发送消息。
- 每个工具核对任务指纹和当前权限。本地策略文件展示可信应用边界，不充当认证系统；部署时保护存储并注入已认证身份。其他 Memory 数据库使用公开 `MemoryStore` 接口；SQLite 验收不代表 PostgreSQL/MySQL 覆盖。

## 适配与验收

创意生成可替换候选结构和评价规则；方案设计可接入可行性/成本核验器；推理搜索可加入领域规则或实际测试工具，将评分用于筛选，而非当作证明。相关集成放在应用工具目录，不混入 Core。

`npm run check:examples:candidates:package -- --provider deepseek` 在仓库外安装实际 tarball，检查无 paths 别名的严格类型、公开导入边界及静默导入，执行真实模型完整任务与上方调用代码。覆盖选择、真实字段融合、非法候选/评价、去重、同分排序、淘汰/阈值、融合失败和禁止回退、预算、Redis 过期/不可用、Memory 故障、输入/权限变更、产物篡改、取消、进程强杀和发布重试。模型输出故障注入在结果中明确标记，正常选择与融合使用实际模型输出。
