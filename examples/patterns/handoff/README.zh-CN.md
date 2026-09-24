# 4.12 Agent Handoff

客服完成受理后，将问题、已完成工作及待办交给技术支持；技术支持检查已有诊断后，可结案、升级人工或转交售后。接收 Agent 明确确认交接包后，应用事务才改变当前负责人。

**当前负责人处理 → 保存交接包 → 接收方确认 → 原子转移责任 → 新负责人继续 → 交付工单结果**

示例使用一个主 Loop 组合公开 Worker Graph，Redis 保存角色 Context，SQLite Memory 保存模型样本和恢复状态；独立业务数据库记录负责人、交接历史及本地更换申请。技术支持读取已有诊断，售后创建申请，不执行诊断、发货或退款。

需要 Node 24、真实 Redis、配置好的模型及环境凭证。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:handoff -- --provider deepseek
npm run example:handoff -- --provider deepseek --scenario resolved
npm run example:handoff -- --provider deepseek --scenario missing-diagnostic
npm run example:handoff -- --provider deepseek --scenario out-of-warranty
npm run example:handoff -- --provider deepseek --stop-after proposal
npm run example:handoff -- --provider deepseek --directory .examples-handoff-tasks/cli-XXXXXX
npm run check:examples:handoff:package -- --provider deepseek
```

每个新任务输出实际目录；恢复时将 `cli-XXXXXX` 换成该目录。报告位于 `<directory>/output/report.json` 与 `report.md`。任务状态、数据库和测试产物位于已忽略的 `.examples-handoff-tasks/`。

[API、完整调用与恢复契约](../../../docs/worker-api/handoff-workflows.zh-CN.md) · [应用工具](../../_shared/tools/handoff/README.zh-CN.md) · [English](README.md)
