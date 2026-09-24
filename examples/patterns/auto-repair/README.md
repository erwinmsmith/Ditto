# 4.15 Automatic repair

**Execute → fail → read errors → diagnose → modify → execute again**

A real model repairs a failing code test, SQL query, or data-processing configuration. Each change binds the actual failed execution, modifies a work copy, and executes again. Only verified revisions become deliverable artifacts; reports retain failed runs, diagnoses, changes and final checks.

One main Loop composes public Worker Graphs, with Redis Context and SQLite Memory. Execution tools live in `_shared/tools/auto-repair`. Requires Node 24, real Redis, configured models and environment credentials.

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
npm run example:auto-repair -- --provider deepseek
npm run example:auto-repair -- --provider deepseek --scenario sql
npm run example:auto-repair -- --provider deepseek --scenario config
npm run example:auto-repair -- --provider deepseek --stop-after patch
npm run example:auto-repair -- --provider deepseek --directory .examples-auto-repair-tasks/cli-XXXXXX
npm run check:examples:auto-repair:package -- --provider deepseek
```

Default: code. Additional scenarios: already-correct and missing-input. Resume with the actual printed directory. Code edits are arithmetic expressions, SQL is a bounded read-only aggregate SELECT, and configuration has fixed fields. A full-repository integration needs an application-owned isolated executor and edit policy.

The ignored `.examples-auto-repair-tasks/` directory stores original inputs, immutable revisions, actual execution output, Memory and `output/report.json/report.md`. Completed tasks also deliver the verified code/query/configuration; SQL and configuration tasks include rows.json.

[Complete API and recovery contract](../../../docs/worker-api/auto-repair-workflows.md) · [Application tools](../../_shared/tools/auto-repair/README.md) · [简体中文](README.zh-CN.md)
