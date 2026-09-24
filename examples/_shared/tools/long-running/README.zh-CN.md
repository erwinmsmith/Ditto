# 长任务与恢复应用工具

通过公开 RegisteredTool 注册到 Interaction Worker。资料、检查点协议、业务幂等性、数据库事务和报告属于应用层，不加入 Core。

| 工具             | 参数               | 行为                                                |
| ---------------- | ------------------ | --------------------------------------------------- |
| `long_load`      | `{}`               | 校验请求、资料和权限，读取并核对业务凭据链          |
| `long_reconcile` | `{checkpoint}`     | 比较 Memory 与业务提交；最多补齐一个已提交批次      |
| `long_batch`     | `{start}`          | 验证真实游标并读取下一批                            |
| `long_validate`  | `{start,proposal}` | 检查批次、覆盖范围、差额、收货状态和原文依据        |
| `long_commit`    | `{start,proposal}` | 一个事务写入审核行、凭据和审计；相同键/内容幂等返回 |
| `long_publish`   | `{report}`         | 重新核对实际提交并写入 CSV、JSON、Markdown          |

无效审核返回 INVALID_REVIEW，由 Loop 在持久预算内重试。权限、存储、来源或提交记录不一致直接失败；模型不能指定数据库路径、改变游标或授权付款。

`domain.ts` 定义请求、资料、批次、凭据与检查点契约；`adapters.ts` 执行真实 SQLite 事务与文件操作。Memory 数据库由共享 storage 工具接入，与业务库分离。移植到远程系统时，必须保留副作用核对能力并实现该系统的幂等机制，不应直接套用本地事务的保证。

[完整 API 与边界](../../../../docs/worker-api/long-running-workflows.zh-CN.md) · [English](README.md)
