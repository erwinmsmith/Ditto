# 4.13 Specialist Agent routing

**User request → main Agent classifies domain → permission/confidence checks → specialist checks task fit → scoped operation → validated answer**

Complete paths cover reimbursement arithmetic, a synthetic contract checklist, SQLite sales aggregation and a discount-function repair. Specialists have independent Context scopes and limited evidence. Unsupported, ambiguous and low-confidence requests require clarification; specialists can also reject a mismatched route before execution.

One main Loop composes public Worker Graphs. Context uses Redis, Memory uses file SQLite, and business tools live in `_shared/tools/specialist-routing`. Use Node 24, real Redis, a configured model and environment credentials.

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:specialist-routing -- --provider deepseek --scenario finance
npm run example:specialist-routing -- --provider deepseek --scenario legal
npm run example:specialist-routing -- --provider deepseek --scenario data
npm run example:specialist-routing -- --provider deepseek --scenario coding
npm run example:specialist-routing -- --provider deepseek --scenario ambiguous
npm run example:specialist-routing -- --provider deepseek --stop-after route
npm run example:specialist-routing -- --provider deepseek --directory .examples-specialist-routing-tasks/cli-XXXXXX
npm run check:examples:specialist-routing:package -- --provider deepseek
```

Resume using the actual directory printed for the task. The ignored `.examples-specialist-routing-tasks/` holds artifacts: sales CSV, repaired fixture/test logs, operation receipts and JSON/Markdown reports. Finance computes without paying; legal applies an internal checklist rather than giving a legal opinion.

[Complete API and runnable consumer](../../../docs/worker-api/specialist-routing-workflows.md) · [Application tools](../../_shared/tools/specialist-routing/README.md) · [简体中文](README.zh-CN.md)
