# 2.5 异常、失败与恢复

[English](README.md) · [控制流程](../README.zh-CN.md) · [全部示例](../../README.zh-CN.md)

通过公开 Graph、Loop、Context、INFER 和 INTERACTION API 执行订单履约任务：读取原始请求、提取订单、预留库存、生成出库记录，并在异常后恢复或补偿。任务检查点和外部业务账本分别存入两个 SQLite 数据库，业务工具通过实际 HTTP 请求访问账本。

## 八类流程

| 流程 / 文件 | 入口 | 任务行为 |
| --- | --- | --- |
| [失败重试](retry.ts) | `runRetry` | 实际来源文件超过读取额度时，按错误中的 requiredBytes 调整参数并有限重试；永久失败直接停止 |
| [备用方案切换](fallback.ts) | `runFallback` | 主资料源返回不可用时，切换到应用允许的备用来源；库存不足等业务拒绝不会触发切换 |
| [超时处理](timeout.ts) | `runTimeout` | 截止时间中止实际 HTTP 读取，持久保存 timed-out 状态，阻止后续写操作 |
| [检查点恢复](checkpoint-resume.ts) | `runCheckpoint` | 保存模型提取和库存预留的检查点；进程重启后跳过已确认阶段，继续出库 |
| [暂停与恢复](pause-resume.ts) | `runPause` / `resumePaused` | 外部操作前保存暂停状态；应用记录与订单指纹绑定的确认或拒绝后再继续 |
| [会话恢复](session-resume.ts) | `runSession` | 重新读取任务状态及公开 Context，用 CONTEXT.UPDATE 恢复并追加问答，回答当前订单和阶段 |
| [失败补偿](compensation.ts) | `runCompensation` | 出库明确拒绝后释放已经预留的库存；补偿失败保留 needs-review 和有效预留 |
| [副作用核对](side-effect-check.ts) | `runSideEffectCheck` | 按稳定操作 ID 查询远端账本；响应丢失后确认实际生效情况，避免重复预留或出库 |

[shared.ts](shared.ts) 保留准备 Graph、单步工具 Graph 和履约阶段组合。应用集成位于 [recovery-store.ts](../../_shared/tools/recovery-store.ts) 和 [fulfillment-service.ts](../../_shared/tools/fulfillment-service.ts)，使用 Node.js 文件、HTTP 和 SQLite 标准库，不增加 Core 节点或供应商配置。

## 运行

需要 Node.js 24+、npm 11+。运行 `npm ci`，按[配置文档](../../../docs/worker-api/configuration.zh-CN.md)设置 `.env` 的模型 Provider、凭据与网络白名单。所有命令显式加载 `ditto.yaml` 和 `.env`，使用真实模型；CLI 启动的本地参考服务监听随机 `127.0.0.1` 端口并执行实际库存事务。

```bash
npm run example:recovery:retry
npm run example:recovery:fallback
npm run example:recovery:timeout
npm run example:recovery:checkpoint
npm run example:recovery:pause
npm run example:recovery:session
npm run example:recovery:compensation
npm run example:recovery:side-effect
```

每次创建 `.examples-recovery-tasks/cli-*/`，终端输出 directory、result 和 checkpoint。默认结果如下：

- retry：首次额度不足，调整后完成履约。
- fallback：主资料源 HTTP 503，备用来源成功，完成履约。
- timeout：服务读取延迟超过 75 ms，保留 timed-out，不预留库存。
- checkpoint：停止在 reserved，保存可恢复检查点。
- pause：保留 paused，等待应用确认。
- session：准备订单并回答当前状态；已有目录则恢复此前 Context 和状态。
- compensation：出库被服务拒绝，释放库存，返回 compensated。
- side-effect：预留库存后服务主动断开响应连接，通过账本核对后完成履约。

用终端返回的目录继续任务。以下命令会重新启动应用和本地服务，复用原数据库：

```bash
npm run example:recovery:checkpoint -- --directory /absolute/path/to/cli-task
npm run example:recovery:session -- --directory /absolute/path/to/cli-task
npm run example:recovery:pause -- --directory /absolute/path/to/paused-task --decision approve --actor example-operator
npm run example:recovery:pause -- --directory /absolute/path/to/paused-task --decision reject --actor example-operator
```

确认已保存后，重新运行 pause 命令并只传 --directory 即可继续，包括确认后进程中断的情况。同一暂停任务仅接受一次有效决策。actor 由应用在验证调用者身份后提供；命令行展示决策输入，框架不提供身份验证服务。端到端实验使用明确标记的 experiment-operator 自动决策。

## 输入与产物

应用首先将原始请求写入 `<id>.txt`，例如：

```text
Fulfillment request. SKU: SKU-731; quantity: 2; delivery address: Dock-North.
```

创建 `RecoveryStore(directory, serviceOrigin)` 后调用 `await store.create(id, requiresApproval)`。模型输出为 `{ sku, quantity, address }`：数量为 1–100 的整数，地址非空且不超过 200 字符。任务 ID 为最多 64 位的字母、数字、下划线或连字符，在业务服务账本范围内唯一；新业务任务使用新 ID。读取文件内容必须与创建任务时保存的指纹一致。

```text
cli-task/
├── task.txt                  # 原始任务材料
├── fixture.json              # CLI 的订单、库存与服务实验配置
├── tasks.sqlite              # 应用任务状态、Context、确认信息和事件记录
├── service.sqlite            # 独立 HTTP 服务的库存、操作、预留、出库和请求账本
└── results/task.json          # 数据库检查点的可读快照
```

SQLite 检查点的 schemaVersion 为 1，revision 在每次状态更新时递增。状态和事件在同一事务内提交；JSON 文件是可重新生成的阅读产物。进程崩溃后，以数据库及服务账本为恢复依据。恢复时使用相同任务 ID、原始材料和同一业务服务账本。

## 状态与恢复契约

| 状态 | 含义与后续处理 |
| --- | --- |
| queued / prepared | 等待模型提取 / 已保存订单和 Context |
| reserved | 远端库存预留已确认并记录检查点，可以继续出库 |
| completed | 出库记录已确认，重复进入直接返回结果 |
| paused / approved / rejected | 等待确认 / 确认已绑定当前订单 / 已拒绝 |
| timed-out | 读取超时，后续写操作未开始，可显式继续检查点流程 |
| uncertain | 操作正在执行或查询不可用，需要再次核对；不盲目重发或补偿 |
| compensated | 出库失败且库存释放已确认，原始失败原因保留 |
| needs-review | 出库失败但未补偿，或补偿失败，需要应用处理 |
| failed | 参数、来源或业务已明确失败；保留最后失败原因 |

completed、compensated、rejected、failed 和 needs-review 的履约重入返回已有结果。取消会抛异常，已保存检查点继续保留。暂停与需要复核的任务由应用推进，不被普通恢复入口自动批准。

### 重试与备用方案

`runRetry` 默认最多 3 次读取，接受 1–5 次；initialMaxBytes 默认 16，范围 1–65536。只有 SOURCE_TOO_LARGE 且 retryable:true、requiredBytes 在允许范围内时扩大额度。额度到限保留 SOURCE_TOO_LARGE；文件缺失、变化或空内容直接失败。模型提取和外部写入在读取成功后执行。

`runFallback` 的 allowedSources 默认 `["primary", "backup"]`，只允许这两个资料源标识。仅 UNAVAILABLE 可触发下一个来源；权限异常、无效响应、库存不足等保持各自失败语义。此示例展示工具资料源备用方案，模型仍使用调用方配置的 Provider。

### 超时与副作用

`runTimeout` 的 timeoutMs 默认 75，范围 1–60000，仅覆盖资料源读取。读取成功才继续履约；超时处理使用新的 Graph 保存状态。调用方 signal 取消继续抛出异常，不被包装成业务超时。Graph 会等待已开始的节点结束，因此工具必须配合 AbortSignal；本例的 fetch 接收该信号。

外部写入拥有稳定键 `<taskId>-reserve`、`<taskId>-ship`、`<taskId>-release` 和订单指纹。查询结果区分 absent、pending、committed、rejected：

1. 查询确认 absent 后才提交相同稳定键的操作。
2. 写入响应不明时再次查询；committed 对照指纹保存检查点。
3. pending 或查询不可用时返回 uncertain；等待后再次进入流程核对。
4. 服务在异步操作前登记唯一操作键，阻止并发重复写；相同键的不同参数产生冲突。

仅凭“客户端没有收到结果”不能判断操作未生效。查询 absent 后的并发竞态仍由服务端幂等键兜底。接入第三方服务时，需要等价的持久幂等、状态查询及参数绑定能力；Ditto 不替外部系统保证这些业务属性。

### 补偿、检查点与会话

补偿只在出库明确 rejected 时执行。库存释放本身也是可查询的幂等操作；已出库订单不能通过释放库存撤回。未知出库结果保留 uncertain，不自动释放可能已经使用的库存。补偿失败保留 needs-review，原始事件及补偿错误可读取。

检查点恢复跳过已保存的模型结果和已确认的预留阶段；如果远端已提交但应用检查点尚未保存，通过稳定键查询找回结果。会话恢复使用持久化的公开 Context，添加当前任务阶段、新问题和模型答案；答案经订单及阶段核验后保存。单纯恢复会话不会再次执行库存或出库操作。

## 任务级端到端实验

```bash
npm run check
npm run check:examples:recovery:tasks
npm run check:examples:recovery:tasks:package
npm run check:examples:recovery:tasks:package -- --provider deepseek
```

20 个实验使用随机原始订单、实际 HTTP 模型、本地 HTTP 服务和两个独立 SQLite 账本，覆盖：

- 有原因的参数调整、重试耗尽、永久失败；允许及禁止的备用方案；业务拒绝不切换。
- 实际读取超时、截止前成功，以及调用方提前取消。
- 子进程 SIGKILL 后恢复检查点、审批暂停，以及新进程中的会话状态和 Context 恢复。
- 出库失败补偿、补偿失败保留库存；响应丢失后核对；核对不可用后崩溃并再次恢复。
- 写入被取消但服务仍在执行时保留 pending；完成后再次核对，无重复预留。
- 完成任务重复进入不重复调用模型、预留或出库。

服务实验开关制造真实 HTTP 503、延迟、连接断开或业务拒绝；工具仍使用真实请求和数据库事务。测试检查库存差额、操作唯一性、请求顺序、持久化状态和产物，并在 Runtime 与服务都关闭后重新打开数据库核验。模型不使用替身；离线回归另行覆盖无效模型结果、审批指纹变化和幂等参数冲突。

包实验在仓库外安装 npm tarball，严格检查公开类型，无源码 paths 别名，验证八个入口导入不启动任务，并执行同一组实验；另验证安装包内的 CLI 暂停、确认和重复进入。报告为 `.examples-recovery-tasks-live-results.json` 或 `.examples-recovery-package-live-results.json`，包含模型调用、Worker 记录、子进程 PID/退出信号及远端账本。产物保存在 `.examples-recovery-tasks/run-*/`，失败断言返回非零退出码。

完整配置和 API 调用见[异常与恢复 API 用法](../../../docs/worker-api/recovery.zh-CN.md)。
