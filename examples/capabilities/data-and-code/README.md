# Data and code capabilities

[简体中文](README.zh-CN.md) · [Public APIs](../../../docs/worker-api/data-code-workflows.md) · [Application tools](../../_shared/tools/data-and-code/README.md)

Twelve workflows compose public Runtime/Graph nodes for Memory, Redis Context, inference and tool operations. Models propose queries/programs/edits, tools actually execute and verify them, and models explain the resulting evidence. Business SQLite is separate from file-backed SQLite Memory.

| Capability | Entry | Result |
| --- | --- | --- |
| Natural-language database query | [query.ts](query.ts) | Parameterized read-only SQL and explanation of actual rows |
| Data cleaning | [cleaning.ts](cleaning.ts) | Executed cleaning program, normalized CSV and rejected-row audit |
| Data exploration | [exploration.ts](exploration.ts) | Missing fields, distributions, counts and Pearson correlation |
| Data calculation | [calculation.ts](calculation.ts) | Executed program computing paid order metrics |
| Data visualization | [visualization.ts](visualization.ts) | PNG/SVG grouped bars and machine-readable chart values |
| Data interpretation | [interpretation.ts](interpretation.ts) | Readable conclusions linked to actual metric values |
| Repository search | [code-search.ts](code-search.ts) | ripgrep matches with paths, line numbers and original text |
| Code generation | [code-generation.ts](code-generation.ts) | Implemented module validated by protected container tests |
| Code modification | [code-modification.ts](code-modification.ts) | Version-pinned edit and before/after test logs |
| Test execution | [execution.ts](execution.ts) | Baseline tests, candidate edit and Node test rerun |
| Failure diagnosis | [diagnosis.ts](diagnosis.ts) | Root-cause findings based on actual failures/logs/source |
| Code review | [code-review.ts](code-review.ts) | Located correctness, validation and overflow findings |

## Run

Use Node.js 24+, Redis, Docker, ripgrep and Python/Matplotlib. Configure model credentials in `.env` and providers in `ditto.yaml`. See [tool installation](../../_shared/tools/data-and-code/README.md).

```sh
export DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
export DITTO_EXAMPLE_DATA_PYTHON="$PWD/examples/_shared/tools/.venv/bin/python"
docker pull node:24-bookworm-slim
npm run example:data-code:query
npm run example:data-code:cleaning
npm run example:data-code:exploration
npm run example:data-code:calculation
npm run example:data-code:visualization
npm run example:data-code:interpretation
npm run example:data-code:code-search
npm run example:data-code:code-generation
npm run example:data-code:code-modification
npm run example:data-code:execution
npm run example:data-code:diagnosis
npm run example:data-code:code-review
```

Each CLI creates an independent `.examples-data-code-tasks/cli-*` task containing inputs, request, snapshots, Memory, tool receipts and outputs. Fixtures vary monetary/test values; expected answers are read only by the acceptance harness.

```sh
node --env-file=.env examples/capabilities/data-and-code/query.ts --checkpoint
node --env-file=.env examples/capabilities/data-and-code/query.ts --directory /absolute/task-directory
```

A checkpoint stops after the tool outcome is durable. Resume reads an existing request without regenerating inputs. Use a new ID for changed inputs/rules or deliberate regeneration. Run one controller per task.

## Data contract

Order columns are `orderId,date,region,quantity,unitCents,status`. Currency is integer cents; statuses are paid/pending/refunded. Quantity is 0–1000 and unit price 0–100000000 cents. Cleaning trims fields, normalizes region/status, converts digit strings, accepts valid ISO/slash-separated dates, fills missing region with Unknown, and keeps the first valid occurrence of an order ID. Missing required values, invalid dates, negative/noninteger/out-of-range values and unknown statuses are rejected with CSV row numbers.

Query/calculation/interpretation concern paid orders. Charts show gross order value separately by status, not net revenue after refunds. Correlation uses cleaned observations; undefined correlation returns null and does not establish causation. Application code independently verifies executed SQL/program results.

These are fixed sales-domain adapters and policies, not an unrestricted database agent. Other schemas, metrics or databases require application adapters and matching validators.

## Code contract

The repository sample contains `invoice.mjs`, `invoice.test.mjs` and a specification README. `invoiceTotal(items)` sums quantity times price, rejects negative/noninteger/unsafe inputs and unsafe arithmetic, and preserves inputs. Only the module may be replaced, with its original SHA-256; tests are controller-owned.

The candidate is delivered as `output/invoice.mjs`. Actual Node container tests run on both original and candidate versions. Deliverables retain TAP output, source hashes and the protected-test hash. Diagnosis and review report findings without editing source. Seven protected tests cover the example specification; they do not prove arbitrary repository/language correctness.

## Evidence and recovery

Material, plan, outcome and interpretation are separate `MEMORY.WRITE` checkpoints. Missing/expired Redis context is reconstructed from Memory; storage failures propagate. A completed tool receipt is indexed by request/plan fingerprints so a crash after tool completion can resume before the Memory outcome has been written. Publication rechecks snapshots and artifact hashes.

Deliverables include `report.json`, `report.md`, and mode-specific SQL, CSV, program, chart, code or test logs. JSON Pointer evidence must match actual result values; code-review quotations must match exact original lines. Traceability checks do not establish every narrative claim. Completed tasks reconcile files without another model call. No repository push, deployment or external code submission occurs.

## Acceptance

```sh
npm run check:examples:data-code:tasks
npm run check:examples:data-code:tasks:package
```

The external-consumer gate installs an actual tarball, checks strict public types without aliases, guards private imports and verifies twelve silent imports. Complete task experiments use real models, Redis, SQLite, Docker, ripgrep and Matplotlib. They check query/calculation/edit/test outputs, cache expiry, storage faults, invalid sources, denied SQL writes, protected tests, bad evidence, code timeouts, tampered artifacts and process-crash recovery. SQLite acceptance does not imply other database acceptance.

## Graph / Loop composition

`shared.ts` exports the full-task `run*Loop`. The `run*()` entry invokes `runtime.loop()` once; its plan yields stage Graphs for Loop-owned scheduling. Reusable subplans share a 1024-Graph execution budget, including recovery and repetitions. Graphs retain node dependencies; all source, model and business effects use public Workers. See [Graph / Loop API](../../../docs/worker-api/graph-loops.md).
