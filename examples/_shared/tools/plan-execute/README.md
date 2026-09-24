# Order fulfillment tools

Application-owned `RegisteredTool` adapters for the [Plan-and-Execute example](../../../patterns/plan-and-execute/README.md). They use the public Interaction Worker, filesystem and Node SQLite. Core has no business-system dependency.

`createDemo` initializes an isolated order, inventory, carrier rates and permission file. `PlanAdapters` registers scoped stock reservation, packing, shipping and receipt operations, plus controller-only authorization, snapshot, verification and publication tools. These helpers do not execute on import. `close()` releases the business database. The application runtime separately closes Redis/Memory.

The local service boundary is `business.sqlite`; it models real transactional changes without booking a production shipment. Replace the adapters with ERP/carrier integrations while retaining scoped identity, live precondition checks, integer monetary values, stable idempotency keys and committed-outcome reconciliation. Never embed a vendor SDK in Core or dispatch tools directly from a Loop generator.

The trusted controller creates requests and permissions. Tool arguments contain only the fixed order ID; model plans select from a closed operation catalog. Audit evidence uses SHA-256 content addressing and immutable files. One active runner owns each task directory. See the [complete contracts](../../../../docs/worker-api/plan-execute-workflows.md) for limits, recovery, database distinctions and production integration responsibilities.
