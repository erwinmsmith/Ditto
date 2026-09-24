# 4.16 Long tasks and recovery

**Execute → checkpoint → interrupt → restore → reconcile → continue**

Review invoices in batches against purchase orders and receiving records, write real business records, and persist progress, model budget and commit receipts. Resume reconciles the database with Memory; a batch committed before its checkpoint was saved is adopted without regenerating its reviews.

One main Loop composes public Worker Graphs, using Redis Context and SQLite Memory. A separate SQLite database stores business reviews. Application tools live in `_shared/tools/long-running`. Requires Node 24, real Redis, configured models and environment credentials.

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:long-running -- --provider deepseek --pause-after-batches 1
npm run example:long-running -- --provider deepseek --directory .examples-long-running-tasks/cli-XXXXXX
npm run example:long-running -- --provider deepseek --scenario matched
npm run check:examples:long-running:package -- --provider deepseek
```

Resume with the actual printed directory. Default mixed has six records and batches of two; matched and empty are also available. Amounts, receiving status, coverage and source quotes are validated. The task records reviews, never payments.

The ignored `.examples-long-running-tasks/` directory stores Memory, the business database, checkpoints and `output/reviews.csv/report.json/report.md`. Run one active Loop per task. Other databases or external systems must implement their own atomic transactions, idempotency keys and reconciliation.

[Complete API and recovery protocol](../../../docs/worker-api/long-running-workflows.md) · [Application tools](../../_shared/tools/long-running/README.md) · [简体中文](README.zh-CN.md)
