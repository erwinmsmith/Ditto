# 3.1 请求理解与交互

[English](README.md) · [基础能力索引](../README.zh-CN.md) · [公开 API 调用](../../../docs/worker-api/understanding.zh-CN.md)

这组示例以“按用户约束生成发布报告”为完整任务，展示自然语言请求如何转成可校验的目标、参数和交互状态。模型负责理解，应用验证参数、提问或提供方案，再生成实际 Markdown / JSON 草稿。工作 Context 保存到 Redis；会话记忆通过 `MEMORY.GET / WRITE` 保存到独立的 `memory.sqlite`。业务状态、输入日志、问题、选择和报告版本保存到 `understanding.sqlite`。

## 六项能力

| 能力 | 入口 / 导出函数 | 示例行为 |
| --- | --- | --- |
| 目标理解 | [goal.ts](goal.ts) / `runGoal` | 识别“生成发布报告”的最终目标、项目和受众，并完成报告任务 |
| 约束识别 | [extract-parameters.ts](extract-parameters.ts) / `runConstraints` | 提取时间、格式、预算、权限要求和内容范围，执行前校验 |
| 需求澄清 | [clarification.ts](clarification.ts) / `runClarification` | 缺少参数时交付明确问题，收到用户补充后继续 |
| 多轮对话 | [conversation.ts](conversation.ts) / `runConversation` | 保留未修改的限制，应用新一轮的格式或范围修订，也可查询状态 |
| 多选项交互 | [choices.ts](choices.ts) / `runChoices` | 展示预算内方案，校验用户选择后生成所选报告 |
| 意图识别 | [intent.ts](intent.ts) / `runIntent` | 区分生成报告、查询进度、取消和不明确请求，并执行不同处理 |

六个入口共用公开 Graph、Context、Memory、推理与交互节点；没有从 Core 源码加载实现。业务适配器 [understanding-store.ts](../../_shared/tools/understanding-store.ts) 使用 Node.js 标准库和 SQLite，位于应用工具目录。

## 运行

使用 Node.js 24+，在仓库根目录配置 `ditto.yaml` 和 `.env` 中的模型 Provider，以及 `DITTO_WORKER_CONTEXT_REDIS_URL`。先启动 Redis，并安装应用侧 SDK（详见[存储接入](../../_shared/tools/storage/README.zh-CN.md)）：

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
```

运行六个入口：

```sh
npm run example:understanding:goal
npm run example:understanding:constraints
npm run example:understanding:clarification
npm run example:understanding:conversation
npm run example:understanding:choices
npm run example:understanding:intent
```

每条命令创建独立目录，输出 `{ directory, result }`。`clarification` 默认缺少时间、格式、预算、权限和范围，会返回 `needs_clarification`；`choices` 返回 `awaiting_choice`；其余默认完整请求会生成报告并返回 `completed`。

`--message "用户请求"` 可以替换新会话的默认消息；`--provider <configured-provider>` 选择供应商。默认业务输入由 `source.json` 提供，项目名见 `result.source.topic`。已有目录中可用同一命令追加消息或提交选择，不会重新初始化资料。

### 澄清后继续

先运行 `example:understanding:clarification`。读取 `result.view.text`、`result.view.missing` 或 `inbox/session-r1.md` 中的问题，然后使用输出的目录、revision 和 token 回复：

```sh
npm run example:understanding:clarification -- --directory /path/to/session \
  --revision 1 --token <question-token> --message-id user-2 \
  --message "截止时间 2027-12-15T09:00:00.000Z，Markdown 格式，预算人民币25元，仅生成本地草稿，不要发布，范围包含变更记录和指标。"
```

补充消息与先前目标一起进入 Context；无需重述项目和受众。等待阶段没有报告副作用。问题必须交付成功后才能回复；过期 revision、错误 token 和复用消息 ID 的不同内容均被拒绝。同一消息 ID 的同内容重试不会重复追加。

### 多轮修订与查询

```sh
npm run example:understanding:conversation -- --directory /path/to/session \
  --revision 1 --message-id user-2 \
  --message "改成 JSON 格式，只保留变更记录，其余目标和限制保持不变。"

npm run example:understanding:conversation -- --directory /path/to/session \
  --revision 2 --message-id user-3 \
  --message "现在报告的进度是什么？不要生成新报告。"
```

第二轮保留项目、受众、期限、预算和草稿要求，生成新版本；第一轮产物保留。查询只返回已有报告状态，不重新登记报告。取消请求停止本轮，保留已有产物；后续明确的新消息可以发起新一轮。

### 多选项交互

```sh
npm run example:understanding:choices -- --directory /path/to/session \
  --revision 1 --token <choice-token> --choice detailed
```

默认提供 `brief`（500 分）和 `detailed`（1000 分）两个方案；预算不足的选项不展示也不能选择。详细方案增加阅读指引，所选内容范围保持不变。选择会创建下一轮版本并直接执行已解析的参数，不需要额外模型调用；旧选择不能重放到新版本。

费用是示例业务的固定成本，用于验证预算约束，不会发生支付。`--message` 和 `--choice` 互斥。token 用于关联已交付问题与版本，不是身份认证凭据；用户身份和会话访问权限由调用这些入口的应用验证。

## 参数与执行规则

| 参数 | 支持的值 |
| --- | --- |
| 意图 | `create_report`、`status`、`cancel`、`unknown` |
| 项目 | 用户原文中的项目名，执行时必须匹配资料 |
| 受众 | 工程团队 `engineering` / 客户 `customers` |
| 截止时间 | 明确的日期、时间和时区，规范化为 UTC ISO 字符串 |
| 格式 | `markdown` / `json` |
| 预算 | 非负整数分；人民币元按 100 分换算 |
| 权限要求 | `draft_only` / `publish` |
| 内容范围 | `changes`、`metrics` 或两者 |

非空参数和明确意图携带 `evidence`，包含用户轮次 ID 与支持该判断的原文片段。应用验证引用确实来自用户消息；这是可追溯性检查，语义解释仍需结合模型结果与业务校验。缺失或含糊参数使用 `null` 并触发澄清，助手问题中的候选值不视为用户要求。

应用仅允许本地草稿。用户要求发布会得到 `POLICY_DENIED`，不会因为模型识别出发布意图就获得发布权限。过期时间、预算不足、未知项目和资料变化同样阻止报告登记。报告只包含用户选择的业务范围，结果文件保留规范化约束与原文证据。

## 持久化与状态

```text
<session-directory>/
  application.json           # CLI 示例类型
  source.json                # 实际报告资料
  understanding.sqlite       # 业务状态、输入日志、报告版本与事件
  memory.sqlite              # MEMORY Worker 的会话记忆数据库
  inbox/session-r1.json       # 完整交互响应
  inbox/session-r1.md         # 可读问题、候选方案或结果
  artifacts/session-r1.md    # Markdown 报告
  artifacts/session-r2.json  # 后续 JSON 报告
  results/session.json       # 最近一次会话结果快照
```

单轮状态包括 `received`、`analyzing`、`needs_clarification`、`awaiting_choice`、`ready`、`completed`、`answered`、`blocked`、`cancelled`、`failed`。业务 SQLite 保存事务状态与已归档版本号；完整 Context 不写入业务数据库。Context 使用会话命名空间与轮次 scope 存入 Redis，Memory 按版本保存交互记忆。缓存过期后通过 `MEMORY.GET` 读取记忆并重建 Redis Context；连接异常不降级到本地快照。运行时关闭后可以重新打开目录；已处理轮次重入不会重复推理或登记。

用户在推理期间发送新消息会使旧轮次结果失效，下一次调用处理新消息。每轮交付后通过 `MEMORY.WRITE` 归档，再确认 `memoryRevision`；写入失败会返回错误，重入补写而不重复生成报告。固定记忆 key 使“Memory 已提交、业务确认前中断”的重试保持幂等。数据库先保存报告，再导出文件；文件交付失败可以重入恢复，不需要重新理解请求。等待回复或选择时可跨进程继续。若进程在 `analyzing` 时被强制结束，应用需先核对状态并使用自己的恢复策略；示例不会自动争抢已有执行权。

## 验证

```sh
npm run check
npm run check:examples:understanding:tasks
npm run check:examples:understanding:tasks:package
```

25 个任务场景覆盖六项能力、中文时间和金额归一化、缺失时区、错误选择、失效回复、预算与权限拒绝、资料变化、交付故障、推理期间的新消息，以及强制结束进程后回复/选择并继续。还覆盖 Redis 缓存过期后从 Memory 恢复、Redis/Memory 故障、报告完成后补写记忆及 Memory 提交后中断。测试使用真实 HTTP 模型、Redis 服务和持久化 SQLite；用户消息与选择由测试控制器模拟。

包验收在仓库外安装 npm tarball，严格类型检查不使用 `paths`，验证六个入口静默导入，并用模块加载限制阻止读取仓库源码或未导出的 Core 实现。报告为 `.examples-understanding-tasks-live-results.json` 或 `.examples-understanding-package-live-results.json`，实际文件保存在 `.examples-understanding-tasks/`。

## Graph / Loop 组合

本模块在 `shared.ts` 导出完整任务的 `run*Loop`。`run*()` 入口只调用一次 `runtime.loop()`，阶段 Graph 通过执行计划交给 Loop 统一调度；子计划复用同一个 1024 次 Graph 执行预算，检查点恢复、分支和重复不会另起调度器。Graph 内保留节点依赖，资料、模型和业务操作仍经过公开 Worker。详见 [Graph / Loop API](../../../docs/worker-api/graph-loops.zh-CN.md)。
