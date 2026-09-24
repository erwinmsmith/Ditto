# 4.14 Multi-perspective discussion

**Independent views → comparison → agreement and disagreement → final synthesis**

Product, finance and reliability Agents independently analyze the same pilot evidence under disclosed criteria. Three views are generated concurrently and saved separately before comparison and synthesis. Reports preserve minority views, overall stances and missing perspectives; topic agreement is not joint approval.

One main Loop composes public Worker Graphs. Context uses Redis, Memory uses SQLite, and application tools live in `_shared/tools/debate`. Use Node 24, real Redis, a configured model and environment credentials.

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

Resume using the actual directory printed by the run. The ignored `.examples-debate-tasks/` holds individual views, Memory SQLite, `output/report.json`, `output/report.md` and `output/comparison.csv`. The example recommends; it does not approve or perform a rollout.

[Complete API, criteria and runnable consumer](../../../docs/worker-api/debate-workflows.md) · [Application tools](../../_shared/tools/debate/README.md) · [简体中文](README.zh-CN.md)
