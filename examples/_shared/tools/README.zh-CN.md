# 应用工具与第三方适配

[English](README.md) · [共用资源](../README.zh-CN.md)

此目录存放示例应用的业务工具、第三方 SDK 适配和注册配置。Core 只提供 `RegisteredTool`、`ToolRegistry`、`createInteractionWorker` 等公开接口；工具的业务规则、供应商依赖、凭据和生命周期由应用管理，不添加到 `src/` 或 Core 的运行依赖中。

[pickup-ledger.ts](pickup-ledger.ts) 导出 `createPickupTool(ledger)`，用于[风险路由](../../control-flow/routing/risk.ts)。工具名为 `record_pickup`，参数为 `{ id, code, quantity }`，成功返回 `ExternalResult` 所需的 `status` 和 `structuredContent`。它实际写入内存 Map，以请求 ID 去重；同 ID 的不同内容拒绝。`effects: ["write"]` 描述副作用，不替代应用授权。

应用启动时显式注册，并保留配置中的网络权限：

```ts
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createPickupTool, type PickupRecord } from "./pickup-ledger.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const ledger = new Map<string, PickupRecord>();
const tools = [createPickupTool(ledger)];
const runtime = createDitto({
  config,
  sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) },
  workers: [createInteractionWorker({ tools })],
});
try {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", {
    call: { id: "request-731", name: "record_pickup", arguments: { id: "request-731", code: "PICKUP-731", quantity: 3 } },
  });
  if (result.status !== "success") throw new Error("Pickup registration failed");
} finally { await runtime.close(); }
```

接入 PDF/OCR/ASR、数据库或其他供应商时，在应用项目安装对应 SDK，将配置和已创建的客户端注入适配器。由应用校验原始文件内容，再提供 `ParsedFile`；扩展名和 MIME 检查不替代字节校验。[文件采集工具](file-ingestion/README.zh-CN.md)提供 PDF/表格/OCR/ASR 的实际实现和配置，任务实验从原始文件覆盖它们。SDK 客户端由创建它的应用关闭。不要把供应商开关或示例业务配置添加到 Core YAML schema，也不要隐式按字符串加载插件。

[pickup-task-store.ts](pickup-task-store.ts) 是应用侧的 SQLite 任务、审批、登记与文件交付适配器，供完整任务实验使用；不属于 Ditto Core 的任务系统。

[order-files.ts](order-files.ts) 提供并行订单任务的文件读取、订单保存、计划保存、报告汇总与交付适配器，仅依赖 Node.js 标准库。配置与调用见[并行 API 用法](../../../docs/worker-api/parallel.zh-CN.md)。

[brief-files.ts](brief-files.ts) 提供循环任务的结构化资料检索、证据校验、草稿修订、轮次记录和文档生成，仅依赖 Node.js 标准库。工具规则、文件目录和预算属于应用；配置与调用见[循环 API 用法](../../../docs/worker-api/iteration.zh-CN.md)。

[recovery-store.ts](recovery-store.ts) 保存恢复示例的应用检查点、公开 Context、确认信息和事件，通过 HTTP 工具访问业务账本；[fulfillment-service.ts](fulfillment-service.ts) 是拥有独立 SQLite 账本的本地库存/预留/出库参考服务。二者均使用 Node.js 标准库。故障实验开关、幂等协议及补偿规则属于应用，配置见[恢复 API 用法](../../../docs/worker-api/recovery.zh-CN.md)。

[human-review-store.ts](human-review-store.ts) 提供应用侧 SQLite 审核单、不可变候选版本、人工决策、文件收件箱和带授权检查的本地效果工具。审批、编辑与认领仅供可信控制器调用，不暴露为模型工具。配置与调用见[人工介入 API 用法](../../../docs/worker-api/human.zh-CN.md)。

[lifecycle-store.ts](lifecycle-store.ts) 提供应用侧任务状态与历史、事务认领、业务版本检查、调用预算、持久化触发规则和通知登记。定时消费者与文件事件适配器在示例中组合公开 API；业务更新和人工停止由可信应用控制器调用。配置与调用见[生命周期 API 用法](../../../docs/worker-api/lifecycle.zh-CN.md)。

[understanding-store.ts](understanding-store.ts) 提供应用侧请求参数校验、输入日志与 Memory 归档指针、澄清与选择记录、报告登记和文件交付。用户回复和选择由可信控制器接收，不注册为模型工具。配置与调用见[请求理解与交互 API](../../../docs/worker-api/understanding.zh-CN.md)。

[Context / Memory 存储接入](storage/README.zh-CN.md)：Agent 示例使用 Redis Context 与数据库 Memory；应用状态库独立保存业务事务。后续示例遵循相同存储与端到端验收约定。

[planning-domain.ts](planning-domain.ts) 与 [planning-store.ts](planning-store.ts) 提供规划示例的工具目录、依赖与预算校验、资源调度、任务账本和实际销售/库存工具。业务规则留在应用；调用见[规划 API](../../../docs/worker-api/planning.zh-CN.md)。

[retrieval/](retrieval/README.zh-CN.md) 提供文档与 SQLite FTS5 Provider、Wikipedia 搜索、HTML 正文解析、来源快照和报告工具，SDK 依赖保留在应用层。

[analysis/](analysis/README.zh-CN.md) 提供材料标准化、参考核验、单位转换、去重、比较和报告工具，复用已有解析器与存储适配器。

上下文输入与发布适配器位于 [context](context/README.zh-CN.md)，由应用持有。

记忆任务工具与数据库接线：[memory](memory/README.zh-CN.md)。

[工具操作适配器](operations/README.zh-CN.md) 提供 HTTP、业务 SQL、文件、隔离代码、Chromium、原生 Electron、SMTP 与 CRM 工具，支持十项公开 API 流程。

[执行结果工具](observation/README.zh-CN.md) 提供实际 HTTP 结果读取、结构化错误映射、证据校验、任务状态事务与产物发布。

[内容工具](content/README.zh-CN.md) 提供固定版本文本快照、内容变换校验、原文引用和 Markdown/JSON/HTML 渲染器。

[多模态工具](multimodal/README.zh-CN.md) 提供 DOCX 解析、图片校验、视频抽帧及媒体证据交付，并复用 PDF/ASR 工具。

[数据与代码工具](data-and-code/README.zh-CN.md) 提供只读 SQL、生成程序执行、统计/绘图、代码检索与受保护测试；[共享执行器](execution/README.md) 供数据和工具操作示例复用。

[验证与安全工具](validation/README.zh-CN.md) 提供输入脱敏、规则/引用检查、事务发布及可信批准绑定。

[RAG 工具](rag/README.zh-CN.md)：授权资料接入、中文全文索引、版本快照、逐条引用检查及答案交付。

[深度研究工具](research/README.zh-CN.md)：研究请求与权限、复用网页适配器和经核验的报告交付。

[ReAct 工具](react/README.zh-CN.md)：限定任务范围的业务操作、手册检索、Chromium 结果下载与幂等恢复。
