# Automatic repair application tools

These tools register through public `RegisteredTool` on Interaction Worker. The edit language, actual executors, acceptance data and revision files belong to the application, not Core.

| Tool             | Arguments                | Behavior                                                                                     |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `repair_load`    | `{}`                     | Validate request, sources, database and permission; persist baseline and return the contract |
| `repair_inspect` | `{revisionId}`           | Read and check revision and existing execution receipt                                       |
| `repair_run`     | `{revisionId}`           | Reuse a receipt or actually run Node tests, a read-only SQLite query, or the CSV workflow    |
| `repair_apply`   | `{baseRevisionId,patch}` | Validate failure binding and edit scope, then persist a new immutable revision               |
| `repair_publish` | `{report}`               | Verify the change/execution chain and write reports and accepted artifacts                   |

Invalid proposals return `INVALID_PATCH` for bounded Loop retry. Permission, storage and integrity problems fail directly. The model cannot change tests, data, paths or authorization. A business execution failure is still a successful tool invocation with failed/blocked execution status, allowing the Loop to decide whether to repair it.

Code edits are arithmetic expressions in a fixed wrapper. SQL is one bounded SELECT shape; configuration only changes fixed enumerable fields. Child processes have an empty environment, a 10-second timeout and a 256 KB output bound. Code/config use work copies and SQL is read-only. These restrictions are not a sandbox for arbitrary third-party programs.

`fixtures.ts` defines trusted tests, CSV, fixed workflow and contracts. `domain.ts` defines edit scope and records. `adapters.ts` performs actual execution and file I/O. A different application must supply its executor, edit policy, acceptance checks and idempotency contract; the model must not decide whether to skip verification.

[Complete API and persistence](../../../../docs/worker-api/auto-repair-workflows.md) · [简体中文](README.zh-CN.md)
