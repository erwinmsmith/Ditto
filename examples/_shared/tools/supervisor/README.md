# Supervisor application tools

`domain.ts` defines the role registry, evidence schemas, allowed next assignments, review binding and final conclusion rules. `adapters.ts` reads actual scoped evidence, validates specialist results and parent lineage, writes immutable handoffs, and replays management history before report delivery. Existing multi-agent source helpers are reused without invoking another workflow.

Register `sup_authorize`, `sup_read_engineering`, `sup_read_operations`, `sup_read_verification`, `sup_save`, `sup_result` and `sup_publish` through Interaction. Verification requires a previously saved blocked engineering result ID; it cannot read a rerun merely because a model requested it. The tools do not run tests, edit systems or grant deployment authority.

`createDemo(directory,overrides,scenario)` initializes an isolated fixture; `SupervisorAdapters(directory,request)` creates no background connections. Runtime storage reuses the [Redis/SQLite adapters](../storage/README.md). Keep authenticated identity and source ownership in the trusted application. See [contracts and recovery](../../../../docs/worker-api/supervisor-workflows.md).
