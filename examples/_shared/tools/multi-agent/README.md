# Multi-Agent application tools

`domain.ts` defines the bounded Agent registry, plan/dependency validation, scoped evidence, specialist contracts and synthesis coverage rules. `adapters.ts` supplies real source-file reads, immutable result writes, hash-checked handoffs and actual Markdown/JSON report delivery for [multi-agent tasks](../../../patterns/multi-agent/README.md).

Tools are `team_authorize`, `team_read_engineering`, `team_read_operations`, `team_save`, `team_result` and `team_publish`. Role read tools have fixed source scopes and reject extra arguments. All run through public Interaction nodes. The planner cannot create a new tool, choose a filesystem path or change the registry. Keep this business logic outside Core.

`createDemo(directory, overrides, ready)` initializes a dedicated source/request/policy set; `TeamAdapters(directory,request)` opens no background connection. Runtime setup reuses Redis/SQLite [storage adapters](../storage/README.md). Protect the task directory; local policy files are not production authentication. See the [API guide](../../../../docs/worker-api/multi-agent-workflows.md) for scope, retries and budgets.
