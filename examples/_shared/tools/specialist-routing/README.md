# Specialist routing application tools

Register these public `RegisteredTool` definitions with Interaction Worker. The role catalog, deterministic business rules, SQLite queries, bounded code repair/tests and output files remain application concerns.

| Tool                | Arguments             | Contract                                                                             |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `routing_authorize` | `{}`                  | Validate request, sources and principal policy                                       |
| `routing_save`      | `{route}`             | Validate classification/intent/threshold, persist immutable route and return routeId |
| `routing_read`      | `{routeId,role}`      | Check selected role and return only its evidence                                     |
| `routing_execute`   | `{routeId,role,plan}` | Check task fit, fixed operation/target and citations; execute and persist receipt    |
| `routing_result`    | `{receiptId}`         | Revalidate receipt, route and artifact hashes                                        |
| `routing_publish`   | `{report}`            | Validate results and write JSON/Markdown reports                                     |

`INVALID_ROUTE/INVALID_PLAN` permit bounded retries. `ROUTE_MISMATCH` stops domain execution and requests clarification. Storage, permission and integrity errors propagate. Arbitrary SQL, paths or commands are outside the protocol. Coding runs only known function/test fixtures from `code-fixture.ts` in child processes without inherited credentials; it is not an untrusted-code sandbox.

`createDemo` initializes `request.json/sources.json/policy.json/sales.sqlite/input-code/`. Replace sources, identity authorization and execution services in application adapters for real integrations while preserving output validation, idempotency and task acceptance contracts.

[Complete API and integration boundaries](../../../../docs/worker-api/specialist-routing-workflows.md)
