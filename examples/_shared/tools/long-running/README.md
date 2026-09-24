# Long task application tools

Tools register through public RegisteredTool on Interaction Worker. Sources, checkpoint contracts, business idempotency, database transactions and report files belong to the application, not Core.

| Tool             | Arguments          | Behavior                                                                                    |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `long_load`      | `{}`               | Validate request, source and permission; read and check the business receipt chain          |
| `long_reconcile` | `{checkpoint}`     | Compare Memory with business commits and adopt at most one committed batch                  |
| `long_batch`     | `{start}`          | Validate the actual cursor and return the next batch                                        |
| `long_validate`  | `{start,proposal}` | Check batch binding, coverage, variance, receiving status and exact source quotes           |
| `long_commit`    | `{start,proposal}` | Atomically write review rows, receipt and audit; repeat identical keys/content idempotently |
| `long_publish`   | `{report}`         | Reconcile actual committed work again and write CSV/JSON/Markdown                           |

Invalid review output returns INVALID_REVIEW for bounded Loop retry. Permission, storage, source or ledger inconsistency fails directly. The model cannot choose database paths, alter the cursor or authorize payment.

`domain.ts` defines request, source, batch, receipt and checkpoint contracts. `adapters.ts` performs real SQLite transactions and file I/O. The shared storage tools provide the separate Memory database. A remote-system integration must retain effect reconciliation and implement that system's idempotency contract rather than assume the local transaction guarantee applies.

[Complete API and boundaries](../../../../docs/worker-api/long-running-workflows.md) · [简体中文](README.zh-CN.md)
