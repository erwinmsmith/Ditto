# 工具链执行

完整场景为：查询客户 → 获取订单 → 核对付款与物流 → 分析状态 → 更新 CRM → 发送通知 → 核验实际结果。一个主 Loop 通过 `graphStep` 组合各阶段 Graph；业务工具放在应用侧，无需增加 Core 私有入口。

## 可运行调用

将 `examples/patterns/tool-chain`、`examples/_shared/tools/tool-chain`、`examples/_shared/tools/storage`、`examples/_shared/tools/evidence.ts` 和 `examples/_shared/tools/execution/files.ts` 复制到消费者项目，安装 Core tarball 与 `storage/dependencies/package.json` 中的 Redis 依赖。使用 Node 24、`ditto.yaml`、环境中的模型凭证和真实 Redis（`DITTO_WORKER_CONTEXT_REDIS_URL`）。以下代码在消费者根目录执行；保留产物时使用持久目录并省略最外层清理。

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createDemo } from "./examples/_shared/tools/tool-chain/service.ts";
import { createTask } from "./examples/_shared/tools/tool-chain/adapters.ts";
import { openToolChain } from "./examples/patterns/tool-chain/cli.ts";
import { runToolChain } from "./examples/patterns/tool-chain/index.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider =
  process.env.EXAMPLE_TOOL_CHAIN_PROVIDER ?? config.model?.provider;
if (!provider || !config.providers[provider])
  throw new Error("Configure provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure model");
const directory = await mkdtemp(join(tmpdir(), "ditto-tool-chain-example-"));
try {
  const demo = await createDemo(directory, "exception", { mode: "parallel" });
  try {
    const request = await createTask(directory, demo.request);
    const app = await openToolChain(directory, request, config);
    try {
      const result = await runToolChain(app.runtime, {
        request,
        model: { provider, model },
      });
      console.log(JSON.stringify(result));
    } finally {
      await app.close();
    }
  } finally {
    await demo.service.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
```

## 组装与调用契约

`runToolChain(runtime,input,options)` 只调用一次 `runtime.loop(runToolChainLoop, ...)`。生成器通过 `yield* graphStep` 提交阶段，Graph 仅包含 Worker 节点，不嵌套子图。计划中没有网络、文件、数据库操作或 Worker 直接执行。`openToolChain` 通过公开包入口注册 Infer、Interaction、Context 和 Memory；这些应用辅助函数不属于新增的 Core API。

| 阶段       | 公开节点 / API                                       | 契约                                      |
| ---------- | ---------------------------------------------------- | ----------------------------------------- |
| 加载与授权 | `MEMORY.GET`、`CONTEXT.LOAD`、`INTERACTION.ACT.TOOL` | 固定请求、身份和策略                      |
| 依赖查询   | `INTERACTION.ACT.TOOL`                               | 客户 → 订单 → 付款 / 物流，返回不可变证据 |
| 分析       | `CONTEXT.LOAD` → `INFER.REASONING.SAMPLE`            | 已核验快照 → 绑定对象和版本的判断         |
| CRM 与通知 | `INTERACTION.ACT.TOOL`、`INTERACTION.OBSERVE`        | 规范化参数 → 已提交回执或分类错误         |
| 保存       | `MEMORY.WRITE` / `MEMORY.UPDATE`                     | 查询、模型输出、预算、操作结果和报告      |
| 核验与交付 | Interaction 调用 `chain_verify`、`chain_publish`     | 实际业务状态及回执 → 报告与通知凭据       |

- **串行工具链：** 客户 → 订单 → 付款 → 物流，按依赖逐步执行。
- **并行工具链：** 客户 → 订单 → 并行查询付款和物流；Runtime 与 Interaction 的并发均为 4。两路完成后统一分析，CRM 与通知仍按顺序执行。
- **条件工具链：** 使用并行查询图，Loop 根据判断分支；正常订单核验后直接结束，异常订单更新 CRM 并通知。串行和并行模式也会写入正常订单状态。

`Request` 固定任务、租户、身份、客户、订单、接收人、服务 origin、目标、模式、两项写入权限及预算。`Snapshot` 校验客户归属、接收人和一致的订单版本。规则优先级为待付款、物流延迟、正常。真实模型生成判断和解释；确定性校验拒绝错误身份、版本、状态或分支。模型解释不直接成为外部写入内容；写入使用固定模板和已验证字段。

## 实际副作用与恢复

参考工具服务通过真实 HTTP 访问独立的 `business.sqlite`，保存客户、订单、CRM、幂等回执、请求时间和通知收件箱。通知会实际写入本地测试服务的持久收件箱，**不是 SMTP 投递，也不连接生产 CRM**。工具与服务位于 `_shared/tools/tool-chain`；生产接入应替换为带身份认证的服务，保持对象范围、版本和回执契约。`policy.json` 展示可信应用控制器的接入位置，不是认证系统；部署时保护任务目录并从可信会话注入身份。

Context 使用真实 Redis，Memory 使用文件 `memory.sqlite`，与业务库分离。缓存缺失或过期后从 Memory 的查询及判断重建上下文；Redis 或 Memory 不可用时显式失败，不自动退化到内存。其他数据库通过公开 `MemoryStore` 接口接入；本例 SQLite 验收不代表 PostgreSQL/MySQL 验收。

每次写入前重新核对权限，以固定 `<task>:crm` / `<task>:notify` 幂等键查询 `/operation`。服务重新验证当前版本、权限和完整参数，再通过事务同时提交操作及回执。通知要求对应 CRM 回执已经存在。实际写入后 HTTP 响应丢失、或进程在 Memory 保存前被终止时，恢复先查回执，避免重复提交。生产服务须提供原子幂等或事务 outbox；单纯的客户端先查再写不能保证恰好一次。

混合版本读取、CRM 写入前版本变化会触发新一轮查询与分析。CRM 已提交后版本变化则返回 `state-changed-after-crm`，保留 CRM 回执，不发送过期通知，也不声称已经回滚。通知失败保留 CRM 成功结果；独立查询失败保留成功分支并停止分析和写入。错误模型输出停止执行；缺少任一必要权限时，在全部副作用之前返回 `needs-human`。

完成前重新查询真实业务状态、CRM、通知收件箱和回执，进行精确比较。查询证据在分析/写入前和发布前均验证校验和。完成表示某一时刻核验通过，不锁定未来业务变化；终态重放返回历史报告，不重新调用 HTTP 或模型。

## 预算、检查点与产物

`maxRounds` 为 1–4 轮，`maxModelCalls` 为 1–4 次，`maxEffects` 为 0–8 次，`maxEffectAttempts` 为每轮每类操作 1–3 次。模型与副作用预算先持久化再执行；回执核对也占用操作预算，崩溃可能消耗一次额度但未保存结果。`deadlineSeconds` 为 1–3600 秒，包含暂停时间，在新查询、模型、操作前检查；它不是强制墙钟超时。HTTP 单次超时为 2 秒，`Options.signal` 可取消正在执行的任务。主 Loop 上限为 1024 个 Graph。

`stopAfter: "reads" | "analysis" | "crm" | "notification" | "report"` 返回检查点。使用同一目录和请求、移除 `stopAfter` 即可继续；每个任务目录只允许一个活跃执行者。completed、partial 和 needs-human 报告均为终态；变更目标、预算或权限前先核对既有副作用，再创建新任务。继续尚未完成的工作应使用检查点。

产物包括 `request.json`、`policy.json`、`evidence/<hash>.json`、`output/report.json`、`output/report.md`；通知确认后还会生成 `output/notification.json`。报告保留各轮判断、失败尝试、已确认回执和预算，不将未知结果视为成功。文件冲突会显式失败，不覆盖既有输出；可重试不可变产物的发布。

## 验收

`npm run check:examples:tool-chain:package -- --provider deepseek` 在仓库外安装真实 tarball，以无路径别名的严格类型配置运行，阻断私有和源码导入，检查静默导入，执行完整任务及上述文档调用。验收包含实际 HTTP 并发与依赖时序、数据库写入和通知入箱、正常订单跳过、版本竞争、提交后响应丢失、部分失败、权限、异常模型输出、预算、Redis 过期/故障、Memory 故障、证据篡改、取消、进程终止与发布重试。模型输出替换明确标记为故障注入，正常流程使用真实模型输出。
