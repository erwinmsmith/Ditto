# 4.16 长任务与恢复

**执行 → 保存检查点 → 中断 → 恢复状态 → 核对 → 继续执行**

分批审核发票、采购订单和收货记录，实际写入业务数据库，保存进度、模型预算和提交凭据。恢复时核对数据库与 Memory：数据库已提交而检查点尚未更新时补齐进度，不重复生成该批审核结果。

一个主 Loop 通过公开 API 组合 Worker Graph；Context 使用 Redis，Memory 使用 SQLite，业务审核库独立保存。应用工具位于 `_shared/tools/long-running`。需要 Node 24、真实 Redis、配置好的模型与环境凭证。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:long-running -- --provider deepseek --pause-after-batches 1
npm run example:long-running -- --provider deepseek --directory .examples-long-running-tasks/cli-XXXXXX
npm run example:long-running -- --provider deepseek --scenario matched
npm run check:examples:long-running:package -- --provider deepseek
```

恢复使用运行时打印的实际目录。默认 mixed，每批两份、共六份资料；另有 matched 和 empty。模型输出需通过金额、收货状态、完整性和原文校验；示例只记录审核结果，不执行付款。

任务目录 `.examples-long-running-tasks/` 已被忽略，保存 Memory、业务数据库、检查点及 `output/reviews.csv/report.json/report.md`。每个任务仅运行一个主 Loop；其他数据库或外部系统需实现自己的事务、幂等键和核对逻辑。

[完整 API 与恢复协议](../../../docs/worker-api/long-running-workflows.zh-CN.md) · [应用工具](../../_shared/tools/long-running/README.zh-CN.md) · [English](README.md)
