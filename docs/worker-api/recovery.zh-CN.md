# 异常、失败与恢复：公开 API 用法

[English](recovery.md) · [Runtime](runtime.zh-CN.md) · [八类示例](../../examples/control-flow/recovery/README.zh-CN.md)

恢复逻辑由应用组合公开 `graph`、`loop`、`runtime.run`、`runtime.loop`、`CONTEXT.LOAD`、`CONTEXT.UPDATE` 和内置推理、交互 Worker。持久化任务、审批、外部操作幂等及补偿策略由应用工具实现。

## 完整调用

在安装 `@codesoul-co/ditto` 的应用内复制 `examples/control-flow/recovery/`、`examples/_shared/tools/recovery-store.ts` 和 `examples/_shared/tools/fulfillment-service.ts`，保留相对路径。准备 `ditto.yaml` 和 `.env`：

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { RecoveryStore } from "./examples/_shared/tools/recovery-store.ts";
import { startFulfillmentService } from "./examples/_shared/tools/fulfillment-service.ts";
import { runCheckpoint } from "./examples/control-flow/recovery/checkpoint-resume.ts";

const config = loadRuntimeConfigFile("ditto.yaml", process.env);
if (!config.model) throw new Error("Configure the model");
const directory = await mkdtemp(join(tmpdir(), "fulfillment-"));
await writeFile(join(directory, "order-731.txt"),
  "Fulfillment request. SKU: SKU-731; quantity: 2; delivery address: Dock-North.");
const service = await startFulfillmentService(join(directory, "service.sqlite"), [
  { sku: "SKU-731", quantity: 20 },
]);
const store = new RecoveryStore(directory, service.url);
await store.create("order-731");
const runtime = createDitto({
  config,
  sandbox: {
    ...config.sandbox,
    tools: store.tools.map(tool => tool.name),
    network: [...(config.sandbox.network ?? []), service.url],
  },
  workers: [
    createContextWorker(), createInferWorker(),
    createInteractionWorker({ tools: store.tools }),
  ],
});
try {
  const checkpoint = await runCheckpoint(runtime, {
    id: "order-731", model: config.model,
  }, { stopAfter: "reserved" });
  console.log(checkpoint.stage, directory);
} finally {
  await runtime.close(); store.close(); await service.close();
}
```

使用 Node.js 24+ 执行 `node --env-file=.env app.ts`。TypeScript 采用 NodeNext 解析，无需仓库源码 paths 别名。上例的服务、数据库、目录和故障实验配置都属于应用；Core 仅接收 Worker 和权限配置。

下次进入相同目录时重新打开服务数据库、创建 RecoveryStore 和 Runtime，直接调用 `runCheckpoint`，不再调用 `store.create`。省略 stopAfter 后从 reserved 继续出库。远端已提交但本地未记录的操作会先通过账本查询恢复。命令行重启例子见[运行说明](../../examples/control-flow/recovery/README.zh-CN.md#运行)。

## 八个入口

公共参数：`runtime: Pick<DittoRuntime, "run" | "loop">`、`input: { id, model }`、`options?: { signal?: AbortSignal }`。Runtime 生命周期由调用方管理。

| 入口 | 附加参数 | 返回 |
| --- | --- | --- |
| runRetry | input.initialMaxBytes 默认 16，范围 1–65536；input.maxAttempts 默认 3，范围 1–5 | Job |
| runFallback | input.allowedSources 默认 `["primary", "backup"]`，无重复、非空且只包含这两个标识 | Job，selectedSource 记录实际来源 |
| runTimeout | input.timeoutMs 默认 75，范围 1–60000 | Job；读取截止时 stage 为 timed-out |
| runCheckpoint | options.stopAfter 可为 prepared 或 reserved | Job；省略 stopAfter 后执行到最终阶段 |
| runPause / resumePaused | 创建任务时 requiresApproval:true | Job，包含暂停、确认或拒绝状态 |
| runSession | input.question 可选，最多 1000 字符 | `{ job, answer: { sku, quantity, stage } }` |
| runCompensation | 无 | Job，补偿成功 compensated，失败 needs-review |
| runSideEffectCheck | 无 | Job，未知效果 uncertain，核对成功后继续 |

Job 包含 schemaVersion、id、revision、stage、sourceHash、order、context、reservation、shipment、approval、requiresApproval、selectedSource、error。模型返回值先通过节点状态、finishReason、消息类型、JSON 及订单字段校验，才保存 prepared 检查点。

### 有限重试

retry.ts 使用原生 Loop。每轮执行只读来源 Graph，update 读取结构化错误中的 code、retryable 和 metadata.requiredBytes，决定是否调整 maxBytes；done 在成功、永久失败或次数到限时返回 true。maxIterations 同时保留硬性边界。只有允许的错误进入下一轮，不把 retryable 当成自动重试指令。

读取成功后执行 `CONTEXT.LOAD → INFER.REASONING.SAMPLE → recovery_prepare`。失败重试阶段不会重复模型调用或写入业务账本。

### 备用与超时

备用示例只切换只读目录来源；应用验证 allowlist，只有 UNAVAILABLE 才尝试下一个。明确业务拒绝不会被另一个来源覆盖，未知写入结果也不会通过切换供应商重发。

超时使用 `AbortSignal.timeout(timeoutMs)`，与调用方 signal 通过 `AbortSignal.any` 合并，仅传给读取 Graph。截止后使用调用方 signal 执行新的处理 Graph，保存 timed-out。调用方主动取消始终抛异常。HTTP 适配器另有 10 秒传输上限；较早的限制先终止请求，传输层不可用按工具错误处理。

Graph 停止调度新节点后会等待已开始节点结束。取消 fetch 可以结束本地等待，但外部服务可能继续处理已接收的写入；此时必须保留并核对稳定操作键。本例实际测试该情况。

## 应用检查点与确认

`new RecoveryStore(directory, serviceOrigin)` 打开已有父目录内的 tasks.sqlite。serviceOrigin 必须是无凭据、无路径的 HTTP(S) origin，并显式加入 sandbox.network。工具按 origin 检查权限，默认不跟随重定向。

- `await store.create(id, requiresApproval = false)`：读取 `<id>.txt` 内容指纹，创建 queued 任务；同 ID 再次创建失败。
- `store.job(id)`：读取支持的 schemaVersion:1 检查点；未知任务或不兼容 schema 抛错。
- `store.decide(id, "approve" | "reject", actor)`：仅允许 paused 任务；保存决策、经过应用认证的操作者和订单指纹，并转换状态。
- `store.tools`：供 createInteractionWorker 显式注册。
- `store.close()`：应用在 Runtime 关闭后关闭数据库。

任务状态和事件用 SQLite 事务一起保存，公开 Context 序列化后存入任务记录。原始文本、模型结构化输出、远端凭据及阶段边界都可追溯。JSON 结果文件是投影，恢复不依赖它是否已经生成。

暂停示例的顺序为 prepare → paused → 应用决策 → resumePaused。库存工具本身也检查审批指纹，直接绕过流程调用工具不能跳过该检查。未批准时返回 paused，拒绝后保持 rejected。示例中的 actor 字符串来自应用信任边界；真实身份认证在业务应用完成。

会话恢复读取持久 Context，通过 CONTEXT.UPDATE 添加当前订单状态和问题，再调用 Sample。答案必须与当前订单、数量和阶段一致；第二次 CONTEXT.UPDATE 保存回答，再写回数据库。会话恢复本身不触发预留、出库或补偿。

## 工具接口

所有工具通过 INTERACTION.ACT.TOOL 调用。下表参数均包含 id：

| 工具 | 其他参数与效果 |
| --- | --- |
| recovery_read | 读取 Job |
| recovery_source | maxBytes；读取来源，返回 text/sourceHash，或明确的来源错误及建议额度 |
| recovery_prepare | order、context、sourceHash；原子保存 prepared 检查点 |
| recovery_catalog | source 为 primary/backup；实际 HTTP 查询库存，记录选中的来源 |
| recovery_operation | kind 为 reserve/ship/release，apply 为 false 时查询、true 时提交稳定操作键 |
| recovery_checkpoint | kind、operation；校验远端已提交结果的指纹和凭据，保存相应阶段 |
| recovery_state | stage、error；保存允许的暂停、超时、未知、复核或失败状态 |
| recovery_context | context、answer；持久保存恢复后的对话 |
| recovery_report | 重新读取 Job 并写入 results/<id>.json |

调用失败可能以 ExternalResult.status 返回，也可能抛异常。绑定函数显式检查状态。`recovery_operation` 查询或提交成功时，structuredContent 是 Operation；其中 state:rejected 是业务拒绝，不是 HTTP 交互失败，应用据此进入补偿分支。

## 外部操作与补偿契约

参考服务 API：

| 请求 | 语义 |
| --- | --- |
| GET /catalog/primary?sku=…、/catalog/backup?sku=… | 读取 `{ sku, available, source }` |
| GET /operations/<key> | 查询 `{ state, fingerprint?, result?, code? }` |
| POST /reserve、/ship、/release | `{ key, order, reservationKey }`；提交持久幂等操作 |

稳定 key 为 `<id>-<kind>`，fingerprint 包含操作类型、规范化订单和预留键。服务先登记 pending，再执行事务；重复请求只能看到原操作，参数不一致返回冲突。查询结果：

- absent：未找到，可以提交相同稳定 key；服务端唯一性继续保护并发竞态。
- pending：远端仍在执行，保持 uncertain，后续重新核对。
- committed：校验结果与当前订单一致后保存检查点。
- rejected：明确没有完成该操作，保留业务原因并按流程处理。

请求响应丢失会触发一次核对；核对不可用或仍未确认则返回 uncertain。再次进入继续先查账本。已保存 reserved 检查点可跳过预留，已完成任务直接返回。

出库明确拒绝后，补偿流程提交 release。释放成功恢复库存并保存 compensated，保留原始出库错误。释放失败保留 needs-review；出库状态不明时不执行释放。已出库订单需要专门业务撤销流程，库存释放不会撤回出库记录。

参考服务的唯一操作表、库存事务和可查询结果构成这些保证的业务前提。接入真实外部系统时通过应用适配器实现等价契约；服务 SDK、鉴权和配置不加入 Core YAML。

## 验收

`npm run check:examples:recovery:tasks:package` 在仓库外安装构建后的 npm 包，验证公开类型、原生 TypeScript 执行及无任务副作用导入。随后运行 20 个任务实验，使用真实模型、HTTP 服务、SQLite 事务、SIGKILL 子进程及重启后的文件核验。详见[实验与产物](../../examples/control-flow/recovery/README.zh-CN.md#任务级端到端实验)。
