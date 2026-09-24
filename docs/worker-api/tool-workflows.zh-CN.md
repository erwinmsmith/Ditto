# 工具和系统操作 API

[English](tool-workflows.md) · [Worker API](README.zh-CN.md) · [十项示例](../../examples/capabilities/tools/README.zh-CN.md)

工具选择、参数补全、API 调用、数据库查询、文件读写、代码执行、网页操作、桌面操作、消息发送和系统写入，都通过已有公开 API 组合。应用用 `INFER.REASONING.SAMPLE` 的原生 `actions` 描述能力，用 `INTERACTION.ACT.TOOL` 执行，再用 `INTERACTION.OBSERVE` 记录结果；这些业务类别不需要新增专用 Core 节点。

## 完整调用

完成 [工具环境安装](../../examples/_shared/tools/operations/README.zh-CN.md) 后，将以下代码保存为仓库根目录 `operations-example.ts`：

```ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "./examples/_shared/tools/storage/workers.ts";
import { OperationAdapters } from "./examples/_shared/tools/operations/adapters.ts";
import { createFixture } from "./examples/capabilities/tools/fixtures.ts";
import { sandbox } from "./examples/capabilities/tools/cli.ts";
import { run } from "./examples/capabilities/tools/api.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = config.model?.provider;
if (!provider || !config.providers[provider]) throw new Error("Configure a provider");
const model = config.providers[provider].model ?? config.model?.model;
if (!model) throw new Error("Configure a model");
await mkdir(".examples-operations-tasks", { recursive: true });
const directory = await mkdtemp(resolve(".examples-operations-tasks/api-"));
const fixture = await createFixture(directory, "api");
try {
  const storage = await openAgentStorage(directory, config);
  try {
    const adapters = new OperationAdapters(directory, fixture.request);
    try {
      const runtime = createDitto({
        config,
        sandbox: sandbox(config, fixture.request),
        workers: [
          ...storage.workers,
          createInferWorker(),
          createInteractionWorker({ tools: adapters.tools }),
        ],
      });
      try {
        const result = await run(runtime, {
          request: fixture.request,
          model: { provider, model },
        });
        console.log(JSON.stringify({ directory, result }, null, 2));
      } finally { await runtime.close(); }
    } finally { adapters.close(); }
  } finally { await storage.close(); }
} finally { await fixture.services.close(); }
```

```sh
npm run build
node --env-file=.env operations-example.ts
```

代码启动独立参考 HTTP/SMTP 服务，配置 Redis Context、SQLite Memory 和业务工具，运行真实模型并写出 `artifacts/operation.json`。将 `api.ts` 与 `createFixture(directory, "api")` 同时改为对应入口与模式，即可运行其他九项。桌面、浏览器、代码任务分别需要 Electron 图形会话、Chromium 和 Docker。

`run(runtime, { request, model }, options?)` 接受仅具备公开 `run` 方法的 Runtime。选项 `signal` 传播取消，`stopAfter: "plan"` 在模型计划提交至 Memory 后返回 `{ status: "checkpoint" }`。正常返回 `Report`，包含 `operationId`、`tool`、`value`、`evidence`、`plan`、`verified: true`。同一任务恢复需使用原输入与持久目录。

## 模型选择与参数补全

[shared.ts](../../examples/capabilities/tools/shared.ts) 的 `planGraph` 先执行 `CONTEXT.LOAD({ scope })`，再将上下文作为消息输入 `INFER.REASONING.SAMPLE`。节点参数为：

| 字段 | 内容 |
| --- | --- |
| `model` | 已配置的 `{ provider, model }` |
| `messages` | 系统规则和从 Redis 加载的任务信息 |
| `actions` | 当前允许工具的 `name`、`description`、`inputSchema`、`target: { kind: "tool", toolName }` |

`actions` 是给模型的调用描述，不执行工具。检查 `NodeResult.status === "success"` 且存在 `output` 后，要求 `finishReason === "action_request"` 和恰好一个 `actionRequests`。从返回动作读取 `name` 与 `arguments`，执行应用 `validatePlan`，再将已批准计划写入 `MEMORY.WRITE`。不从普通文本中提取 JSON 来伪装原生工具调用。

示例的工具选择同时提供真实订单查询和库存查询工具；当前任务需要订单支付状态，因此模型应选择订单工具。参数补全将上下文中的国家、重量与 express 服务传给真实 HTTP 运费工具。工具 schema、参数范围、任务授权及收件人限制由 [domain.ts](../../examples/_shared/tools/operations/domain.ts) 定义。

## 执行和观察

[RegisteredTool](interaction.zh-CN.md) 包含 `name`、`inputSchema`、`validate`、`effects`、`execute`。`validate` 在应用边界再次检查参数；`execute` 接收参数与 `WorkerContext`，返回 `{ status: "success", structuredContent }` 等 `ExternalResult` 内容。使用 `context.signal` 取消可取消的工作，使用 `context.services.sandbox.assert` 检查网络许可。

调用 Graph 将 `INTERACTION.ACT.TOOL` 的输入设为 `{ call: { id, name, arguments } }`，后继 `INTERACTION.OBSERVE` 依赖执行节点，并传入 `{ result: effect }`。这两个节点的结果直接是 `ExternalResult` 和 `Observation`，不套用 INFER / MEMORY 的 `NodeResult.output` 访问方式。

执行成功后仍需应用核验：数据库金额、文件实际内容、下载 CSV、桌面保存文件、SMTP 接收记录、CRM 版本，以及代码返回的计算值。`validateReceipt` 通过后才能保存结果 Memory、归档报告和发布产物。工具执行成功不自动等于业务目标完成。

## 持久化与重试边界

`scope` 使用 `operations:<tenant>:<id>`；`MEMORY.GET/WRITE` 的 key 在该前缀后追加 `input`、`plan`、`result`、`report`。Memory 每条记录保存固定请求的指纹，拒绝同一 ID 换输入。所有访问均通过 Runtime Graph；SQLite 客户端留在存储适配器内。

Redis 缓存丢失时由 Memory 重建，Redis 不可用则报错。已保存 `result` 的恢复不再调用模型或重复工具效果。模型或 Worker 的 `NodeResult` 非成功、工具 `ExternalResult` 非成功、观察失败、参数错误和实际业务不符都会阻止产物发布。构造、连接、Graph 和权限错误仍可能抛异常，由调用方处理。

取消与超时不表示外部动作已回滚。文件和桌面保存采用内容一致性检查；CRM 使用事务性幂等记录；邮件在重试前核对参考邮箱中的 Message-ID。后两种方式依赖接收系统能力，不是 Runtime 提供的跨系统事务或普通 SMTP 的通用一次性投递保证。接入生产系统应在应用适配器中实现该系统的幂等和核对策略。

## 包消费与任务验收

`npm run check:examples:tools:tasks:package` 在仓库外安装真正的 npm tarball，并单独安装应用 SDK。示例只从 `@codesoul-co/ditto/runtime`、`@codesoul-co/ditto/contracts`、`@codesoul-co/ditto/worker/*` 已导出的路径使用 Core。严格 TypeScript 不配置 paths，运行时拦截非公开入口及仓库回退，所有十个入口导入无执行副作用，然后运行完整 40 场景套件。

验收使用真实模型、Redis、文件 SQLite、HTTP 与 SMTP 接收服务、Chromium、Electron 可见窗口和 Docker。包括缓存过期、依赖故障、权限拒绝、错误参数、执行失败、进程中断和副作用核对。详见 [测试入口](../../scripts/check-examples-operations-tasks.ts)。第三方依赖、桌面资产和业务服务都属于应用，不加入 Core 发布包。
