# 4.14 多观点讨论

**多个独立观点 → 逐项对比 → 共识与分歧整理 → 最终综合**

产品、财务、可靠性三个 Agent 对同一份产品试点资料独立分析，各自使用公开的评估标准。三份观点并行产生并独立保存，随后比较和综合。报告保留少数意见、整体立场和缺失观点；逐项一致不等同于共同批准方案。

一个主 Loop 组合公开 Worker Graph；Context 使用 Redis，Memory 使用 SQLite，应用工具位于 `_shared/tools/debate`。需要 Node 24、真实 Redis、已配置的模型和环境凭证。

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:debate -- --provider deepseek
npm run example:debate -- --provider deepseek --scenario aligned
npm run example:debate -- --provider deepseek --scenario missing-cost
npm run example:debate -- --provider deepseek --scenario unsafe
npm run example:debate -- --provider deepseek --stop-after views
npm run example:debate -- --provider deepseek --directory .examples-debate-tasks/cli-XXXXXX
npm run check:examples:debate:package -- --provider deepseek
```

恢复时使用运行打印的实际目录。已忽略的 `.examples-debate-tasks/` 保存各角色观点、Memory 数据库、`output/report.json`、`output/report.md` 和 `output/comparison.csv`。示例输出讨论建议，不执行审批或上线。

[完整 API、标准与调用](../../../docs/worker-api/debate-workflows.zh-CN.md) · [应用工具](../../_shared/tools/debate/README.zh-CN.md) · [English](README.md)
