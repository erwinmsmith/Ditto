# 4.15 自动修复

**执行 → 失败 → 读取错误 → 分析原因 → 修改 → 再执行**

使用真实模型修复代码测试、SQL 查询或数据处理配置。每次修改都绑定实际失败记录，在工作副本中重新执行，通过固定测试或业务结果校验后才交付修复文件。报告保留所有失败、原因说明、修改版本和最终验证。

一个主 Loop 通过公开 API 组合 Worker Graph，Context 使用 Redis，Memory 使用 SQLite。应用执行工具位于 `_shared/tools/auto-repair`。需要 Node 24、真实 Redis、已配置模型及环境凭证。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:auto-repair -- --provider deepseek
npm run example:auto-repair -- --provider deepseek --scenario sql
npm run example:auto-repair -- --provider deepseek --scenario config
npm run example:auto-repair -- --provider deepseek --stop-after patch
npm run example:auto-repair -- --provider deepseek --directory .examples-auto-repair-tasks/cli-XXXXXX
npm run check:examples:auto-repair:package -- --provider deepseek
```

默认 code；另有 already-correct（无需修复）和 missing-input（升级人工）。恢复使用 CLI 打印的真实目录。代码仅修改算术表达式，SQL 仅允许只读聚合 SELECT，配置只允许固定字段；扩展到完整仓库需由应用提供隔离执行器和修改策略。

`.examples-auto-repair-tasks/` 已被忽略，保存原始资料、不可变版本、真实执行输出、Memory 数据库及 `output/report.json/report.md`。通过验收的代码/SQL/配置写入 output，SQL 和配置任务同时交付 rows.json。

[完整 API 与恢复契约](../../../docs/worker-api/auto-repair-workflows.zh-CN.md) · [应用工具](../../_shared/tools/auto-repair/README.zh-CN.md) · [English](README.md)
