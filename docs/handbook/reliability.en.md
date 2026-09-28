# Results, errors, stopping and recovery

Reliable Agents need verifiable state and actual effects at every stage. A resolved Promise, model answer or accepted receipt alone does not prove business completion.

## 1. Identify the result contract

| Capability | Return type | Check |
| --- | --- | --- |
| INFER / MEMORY / RETRIEVAL | NodeResult | status before output; error on failure |
| CONTEXT | Context / ContextSelection | Read directly on success; errors throw |
| ACT.TOOL | ExternalResult | success/failed/cancelled/timeout/unknown |
| ACT.MCP | discover/invoke union | operation first; then result.status for invoke |
| OBSERVE | Observation | Preserves action status and message; not proof of success |
| OUTPUT | OutputReceipt | accepted/rejected/unknown and deliveryId |

Graph does not convert ordinary failure objects into exceptions. Accessing `result.output!` without checking may continue invalid business work. Validate the result before binding the next input.

## 2. Distinguish failure causes

| Category | Example | Next action |
| --- | --- | --- |
| Invalid input | Unknown tool, schema or target | Correct or clarify; do not repeat unchanged input |
| Permission denial | Unauthorized tool or tenant object | Stop/escalate; do not bypass with another model |
| Temporary failure | Rate limit or interrupted connection | Bounded backoff after checking side effects |
| Business failure | No stock or rejected approval | Preserve the reason and adjust the flow |
| State conflict | Redis CAS or business version changed | Reload and reevaluate |
| Uncertain outcome | Response lost after a write | Reconcile actual state/idempotency ledger before retrying |

Bound attempts, total time, model calls, tokens and external actions. Loop maxIterations only limits Graph executions; it does not replace other budgets.

## 3. Cancellation and timeouts

Pass signal to Runtime and forward ctx.signal through tools and SDKs. Do not swallow cancellation and start further stages.

Stopping the wait does not ensure the underlying action stopped or rolled back. Use cancellation-aware SDKs, database transactions and statement timeouts, and executors that clean up child processes. Committed actions need compensation or reconciliation, not blind Graph replay.

## 4. What to save in a checkpoint

```text
taskId / tenantId / schemaVersion
status / phase / revision
validatedRequest
completedSteps / nextStep
remainingBudget
artifactReferences / sourceDigests
pendingApproval
idempotencyKeys / effectReceipts
```

Persist reconstructible JSON state, not generator stacks, functions or connections. On recovery, recreate Runtime/resources, choose the next Graph from persistent records and validate inputs, versions, artifacts and external effects.

Context snapshots can be rebuilt, but writes must not be blindly replayed. Use stable idempotency keys and reconcile the window between business commit and checkpoint commit.

## 5. Human intervention

At a human boundary, persist waiting state and the version awaiting review, then return. A new request through a trusted controller supplies reviewer identity, authority, decision, edited version and task association. Reload the checkpoint and continue the Loop.

Do not keep a process waiting forever or treat model-generated `approved:true` as permission. Record edited content versions and invalidate earlier checks/approvals according to business rules. See [Human-in-the-loop](../../examples/patterns/human-in-the-loop/README.md).

## 6. Delivery and compensation

Define completion before output: a readable file, expected record version, notification acceptance or traceable citations. Validate both OUTPUT receipts and actual artifacts; accepted only describes sink acceptance.

For compensatable multi-step operations, record each effect receipt and compensation action. Compensation can also fail; preserve recoverable state and information for a human operator. Avoid hiding every external action inside one opaque tool.

## 7. Choose an implementation

[Eight recovery flows](../../examples/control-flow/recovery/README.md) cover retry, fallback, timeout, checkpoints, pause, sessions, compensation and reconciliation. [Auto-repair](../../examples/patterns/auto-repair/README.md) executes, diagnoses, fixes and reruns. [Long-running tasks](../../examples/patterns/long-running/README.md) demonstrate process recovery and reconciliation of committed effects.

Test success, business failures, infrastructure interruption, lost responses after output, Redis expiry, restarts, duplicate requests, expired approvals and exhausted budgets. Verify final artifacts, not only model-call counts.
