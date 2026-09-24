# 返回值、错误、停止与恢复

Agent 的可靠性来自每个阶段可验证的状态和实际效果。一次 Promise resolve、一次模型回答或一个 accepted 回执，都不足以单独证明业务任务完成。

## 1. 先识别返回契约

| 能力 | 返回值 | 检查方式 |
| --- | --- | --- |
| INFER / MEMORY / RETRIEVAL | NodeResult | 先检查 status，再读取 output；失败检查 error |
| CONTEXT | Context / ContextSelection | 正常直接读取；失败抛异常 |
| ACT.TOOL | ExternalResult | success/failed/cancelled/timeout/unknown |
| ACT.MCP | discover 或 invoke union | 先检查 operation；invoke 再检查 result.status |
| OBSERVE | Observation | 保留动作状态与 message，不等于成功 |
| OUTPUT | OutputReceipt | accepted/rejected/unknown，核对 deliveryId |

Graph 不会将普通失败对象自动转换成异常。下游步骤若直接访问 `result.output!`，可能继续执行错误业务逻辑；显式检查之后才能构造下一个输入。

## 2. 区分失败原因

| 类型 | 例子 | 后续动作 |
| --- | --- | --- |
| 输入错误 | 未知工具、非法 schema、错误 target | 修正参数或澄清，不重复同一输入 |
| 权限拒绝 | 未授权工具、对象不属于当前租户 | 停止或转人工，不通过换模型绕过 |
| 暂时故障 | 限流、连接中断 | 有界退避；先判断是否产生副作用 |
| 业务失败 | 库存不足、审批拒绝 | 保留原因，调整流程 |
| 状态冲突 | Redis CAS、业务版本更新 | 重读最新状态后重新判断 |
| 结果不确定 | 写入后响应丢失 | 查询实际状态/幂等账本后决定是否重试 |

重试次数、总时间、模型调用数、token 和外部动作数都需要限制。Loop 的 maxIterations 只限制 Graph 执行次数，不替代其他预算。

## 3. 取消与超时

调用 Runtime 时传 signal，工具/SDK 中继续传递 ctx.signal。主任务取消后不得通过内部 catch 吞掉取消并启动更多阶段。

停止等待并不保证底层操作停止，更不等于事务回滚。使用支持取消的 SDK，数据库操作使用事务与语句时限；进程/容器执行器负责清理子进程。已提交外部动作需要业务补偿或核对，而不是简单重新运行整个 Graph。

## 4. 检查点保存什么

```text
taskId / tenantId / schemaVersion
status / phase / revision
validatedRequest
completedSteps / nextStep
remainingBudget
artifactReferences / sourceDigests
pendingApproval
idempotencyKeys / effectReceipts
```

保存 JSON 可重建状态，不保存生成器栈、函数或数据库连接。恢复时重新创建 Runtime 和连接，从持久记录决定下一张 Graph，检查输入、版本、产物和外部效果是否仍有效。

Context 快照可以重建，但业务写入不可盲目重放。每个副作用有稳定幂等键，检查点和业务系统提交之间的窗口通过查询/对账处理。

## 5. 人工介入

到达人工边界时持久化 waiting 状态与待审核版本，然后返回。新请求通过可信控制器提供审批人、权限、决定、编辑版本和关联任务；重新加载检查点后继续 Loop。

不是保持进程永远等待，也不是模型输出 `approved:true` 就授权。人工编辑后记录新内容版本，并使之前的验证/审批结果按业务规则失效。参考 [Human-in-the-loop](../../examples/patterns/human-in-the-loop/README.zh-CN.md)。

## 6. 交付与补偿

输出前明确“任务完成”的判定：文件存在并可读取、业务记录版本正确、通知服务接收、引用可定位等。校验 OUTPUT 回执与实际产物；accepted 只描述 sink 接收请求。

对于需要补偿的多步业务，记录每步 effect receipt 和补偿操作。补偿本身也可能失败，应返回可恢复状态和人工所需信息。不要把所有外部动作包装成一个不可观察的“万能工具”。

## 7. 从示例选择实现

[8 类异常与恢复](../../examples/control-flow/recovery/README.zh-CN.md)覆盖重试、备用、超时、检查点、暂停、会话、补偿和副作用核对；[4.15 自动修复](../../examples/patterns/auto-repair/README.zh-CN.md)展示真实错误→修复→重跑；[4.16 长任务](../../examples/patterns/long-running/README.zh-CN.md)展示跨进程恢复与已提交动作核对。

上线前至少验证：成功路径、业务失败、基础设施中断、输出后丢响应、Redis 过期、进程重启、重复请求、审批过期和预算耗尽。测试应检查最终业务产物，而不只统计模型调用次数。
