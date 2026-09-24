# 4.12 Agent Handoff

Customer service transfers intake, evidence and remaining work to technical support. Technical support reads existing diagnostics, then closes, escalates or transfers to after-sales. The application changes ownership only after the receiving Agent explicitly acknowledges the packet.

**Current owner handles task → persist packet → receiver acknowledges → atomic ownership transfer → new owner continues → deliver case outcome**

One main Loop composes public Worker Graphs. Redis stores per-role Context; SQLite Memory stores samples and recovery state. A separate business database tracks ownership, accepted handoffs and local replacement requests. The example reads diagnostic records and creates requests; it does not run diagnostics, ship products or issue refunds.

Use Node 24, real Redis, a configured model and environment credentials.

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

Replace `cli-XXXXXX` with the actual directory printed for the task. Outputs are `<directory>/output/report.json` and `report.md`. The ignored `.examples-handoff-tasks/` directory holds state, databases and test artifacts.

[API, runnable consumer and recovery](../../../docs/worker-api/handoff-workflows.md) · [Application tools](../../_shared/tools/handoff/README.md) · [简体中文](README.zh-CN.md)
