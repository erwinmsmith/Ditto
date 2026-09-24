# Handoff 应用工具

这些工具实现设备工单领域协议，通过公开 `RegisteredTool` 注册到 Interaction Worker；业务规则、SQLite 和报告文件属于应用，不加入 Core。

| 工具              | 参数                                  | 作用                                                                      |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `handoff_ticket`  | `{}`                                  | 校验请求、资料和工单历史，读取权威负责人和 pending                        |
| `handoff_read`    | `{agent,version}`                     | 当前负责人加载限定资料及父交接；旧负责人、未接收和等待转交中的操作被拒绝  |
| `handoff_decide`  | `{agent,version,decision}`            | 校验资料与角色规则，保存提议或提交结案/升级；更换申请和售后结案同事务提交 |
| `handoff_accept`  | `{agent,version,packetId,acceptance}` | 接收确认后原子转移责任；相同确认幂等，冲突确认失败                        |
| `handoff_publish` | `{report}`                            | 与数据库状态核对后写入不可变 JSON/Markdown 报告                           |

`decision` 和 `acceptance` 校验失败分别返回 `INVALID_DECISION`、`INVALID_ACCEPTANCE`，由 Loop 有限重试。存储、权限、版本和包摘要异常直接失败。每个工具都检查 `policy.json` 中 enabled 和操作者 principals；这些角色标识由可信控制器传入，不是多租户服务的独立身份认证。

`domain.ts` 定义路由、字段校验与包摘要，`adapters.ts` 实现固定工具和数据库事务。`createDemo` 建立 `request.json/sources.json/policy.json/tickets.sqlite`；恢复使用既有目录。模型只读取投影资料，不获得客户邮箱。更换记录仅为本地申请，不发送邮件、发货或退款。

[完整契约与接入边界](../../../../docs/worker-api/handoff-workflows.zh-CN.md)
