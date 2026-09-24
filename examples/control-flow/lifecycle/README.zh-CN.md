# 2.7 任务生命周期控制

[English](README.md) · [上一级](../README.zh-CN.md) · [公开 API 调用](../../../docs/worker-api/lifecycle.zh-CN.md)

五个示例以“生成并登记发布通知”为完整任务。应用读取输入文件，将业务对象与任务保存到 SQLite，调用真实模型生成通知，并在事务中检查业务状态、登记通知和完成任务。每次状态变化都记录时间及原因。

## 示例

| 流程 | 入口 / 导出函数 | 任务行为 |
| --- | --- | --- |
| 任务状态跟踪 | [status-tracking.ts](status-tracking.ts) / `runStatusTracking` | 记录排队、执行、失败和完成；读取任务及完整状态历史 |
| 状态检查后执行 | [state-check.ts](state-check.ts) / `runStateCheck` | 开始前检查业务是否就绪，登记结果前再次核对状态与版本 |
| 安全停止 | [safe-stop.ts](safe-stop.ts) / `runSafeStop` | 根据取消信号、截止时间、调用预算或人工停止请求阻止后续登记 |
| 定时触发 | [scheduled.ts](scheduled.ts) / `runScheduled` | 持久化绝对触发时间，到期后认领并执行一次任务 |
| 事件触发 | [event-triggered.ts](event-triggered.ts) / `runEventTriggered` | 从实际文件收件箱读取事件，校验范围、去重并启动完整任务 |

全部流程使用 `@codesoul-co/ditto` 公开入口。任务数据库、定时规则、收件箱及业务工具在应用侧 [lifecycle-store.ts](../../_shared/tools/lifecycle-store.ts)，不属于 Core 的调度服务。通知登记是本地 SQLite 业务效果；不会发送邮件、向外部系统发消息或公开发布内容。

## 运行

使用 Node.js 24+，在仓库根目录配置 `ditto.yaml` 和 `.env` 中的模型 Provider：

```sh
npm run example:lifecycle:tracking
npm run example:lifecycle:state
npm run example:lifecycle:stop
npm run example:lifecycle:scheduled
npm run example:lifecycle:event
```

每条命令自动构建包，创建独立目录，输出 `{ directory, result }`。`result` 包含 `job`、`release`、`notice` 和 `history`。可添加 `--provider <configured-provider>` 选择模型供应商。

| 命令 | 默认结果 |
| --- | --- |
| `tracking` | 生成通知，事务登记并返回 `completed` |
| `state` | 业务初始为 `draft`，返回 `blocked`，不调用模型 |
| `stop` | 调用预算为 0，返回 `stopped / MODEL_CALL_BUDGET` |
| `scheduled` | 等待创建时刻之后约 250 毫秒，再完成任务 |
| `event` | 尚无事件，返回 `waiting`，不调用模型 |

### 状态检查、继续与停止

使用第一次输出中的目录重新运行：

```sh
npm run example:lifecycle:state -- --directory /path/to/task --ready
npm run example:lifecycle:tracking -- --directory /path/to/completed-task
```

`--ready` 演示可信业务控制器将同版本对象设置为可执行。任务在开始前要求 `status=ready` 且版本等于创建时记录的版本；推理期间对象撤回或版本变化，会阻止旧结果登记。已完成任务重入不会再调用模型或登记第二份通知。

安全停止可显式配置预算和期限：

```sh
npm run example:lifecycle:stop -- --model-call-budget 1
npm run example:lifecycle:stop -- --model-call-budget 1 --deadline-ms 100
npm run example:lifecycle:event -- --directory /path/to/waiting-task --stop
```

CLI 捕获 `SIGINT` / `SIGTERM` 并把 `AbortSignal` 传入 Runtime 与模型 Provider。清理路径使用未取消的独立调用保存停止状态。`--stop` 为可信控制器的持久化停止请求，阻止后续登记；它本身不向其他进程正在进行的模型请求发送取消信号。运行中的调用方如需中断请求，应同时取消该次调用的信号。

已经完成的事务不会因稍后收到取消而回滚或改写为停止。预算计数表示已认领的推理尝试，不是计费 token 或保证 Provider 已收到的请求数。失败和停止任务不会自动重试；应用可以另建任务，或组合[恢复流程](../recovery/README.zh-CN.md)。

### 定时触发

```sh
npm run example:lifecycle:scheduled -- \
  --due-at 2027-01-15T09:00:00+08:00 --wait-ms 0

npm run example:lifecycle:scheduled -- --directory /path/to/task --wait-ms 60000
```

`--due-at` 使用带时区的 ISO 时间。触发时间在创建时存入 SQLite；`--wait-ms 0` 仅检查一次并返回。等待窗口结束仍未到期时，任务保持 `waiting`，不会标记失败或停止。重新运行会读取同一触发时间；若已经过期，立即尝试执行。

这是应用进程内的一次性定时消费者。需要后台应用、服务管理器或已有调度器持续运行/再次调用它；进程退出期间不会自行唤醒。示例使用实际时钟与可取消的短轮询，到期后尽快执行，不承诺精确到毫秒。并发消费者通过 SQLite 事务认领，只有获得执行权的一方调用模型。

### 事件触发

```sh
npm run example:lifecycle:event
npm run example:lifecycle:event -- --directory /path/to/task --emit-event --wait-ms 5000
```

`--emit-event` 由示例生产者写入真实 `inbox/task.json`，然后消费者读取并执行。也可以保持消费者运行，由独立应用原子写入事件文件：

```json
{
  "id": "release-ready-001",
  "type": "release.ready",
  "taskId": "task",
  "releaseId": "REL-copy-from-result",
  "revision": 1
}
```

事件必须匹配任务的业务 ID 和版本。事件接收与 `waiting → queued` 在同一事务中完成；重复 ID 的同内容事件可重放，同 ID 不同内容拒绝接收。有效事件不会绕过业务状态检查，也不能重启已停止任务。错误事件使尚在等待的任务进入 `failed / TRIGGER_INVALID`。

收件箱为受应用控制的本地目录，每个任务对应一个事件槽位，不是通用消息队列。邮件、消息平台或 webhook 适配器应先验证来源和权限，再转换为上述事件；示例不代替这些平台的接收协议。终态任务不会继续扫描收件箱。

## 状态与文件

| 状态 | 含义 |
| --- | --- |
| `waiting` | 等待时间或事件 |
| `queued` | 已具备触发条件，等待认领 |
| `running` | 已认领并保留一次模型调用预算 |
| `blocked` | 业务状态或版本不匹配；更新后可再检查 |
| `stopped` | 因取消、期限、预算或人工请求停止 |
| `failed` | 执行异常、无效结果或触发事件错误 |
| `completed` | 通知登记与完成状态已在同一事务中提交 |

```text
<task-directory>/
  application.json       # CLI 示例类型
  task.source.json       # 创建任务时的业务输入
  lifecycle.sqlite       # tasks / releases / notices / events / history
  inbox/task.json        # 事件流程的实际输入
  results/task.json      # 某次读取的完整结果快照
```

SQLite 是任务与业务状态的权威来源；输入文件用于初始化，后续业务修改通过应用控制器完成。调用 `store.result(id)` 可在另一个连接/进程持续读取状态和有序历史，`results/task.json` 是导出快照。通知主键为任务 ID，避免同一任务重复登记；创建不同任务 ID 表示独立业务意图。

等待阶段可重启消费者继续。若进程在 `running` 阶段被强制终止，任务保留执行记录，不会自动夺取执行权；应用应先核对业务效果，再停止或进入恢复流程。将本地登记替换为外部操作时，需要外部系统自己的幂等及状态条件写入。

## 验证

```sh
npm run check
npm run check:examples:lifecycle:tasks
npm run check:examples:lifecycle:tasks:package
```

任务实验覆盖 20 个场景：状态跟踪与重入、阻塞后继续、版本变化、预算和期限、推理前及进行中的取消、人工停止、真实时间触发、事件文件跨进程生产、强制终止后恢复等待、重复/错误事件、并发认领、实际 SQLite 写入失败，以及提交后取消保留已完成效果。

模型使用真实 HTTP Provider；测试检查实际业务表、状态历史和导出文件，并记录执行轨迹。包实验在仓库外安装 `npm pack` 产物，严格类型检查不使用源码路径别名，验证模块导入不自动执行，再运行完整任务实验。报告为 `.examples-lifecycle-tasks-live-results.json` 或 `.examples-lifecycle-package-live-results.json`，文件保存在 `.examples-lifecycle-tasks/`。离线测试另外覆盖模型抛错、无效 JSON 和截断响应。
