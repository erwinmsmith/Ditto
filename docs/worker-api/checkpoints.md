# Checkpoints, isolated state and token budgets

Available in `@codesoul-co/ditto@0.1.1` from the root package or `/runtime`.
All APIs are opt-in; existing execution behavior is unchanged.

## Portable state

```js
import { checkpointState, restoreState, BranchStore } from '@codesoul-co/ditto';
const saved = checkpointState('session-1', 'app-config-v1', { step: 3, messages: [] });
const state = restoreState(JSON.parse(JSON.stringify(saved)), 'session-1', 'app-config-v1');
const store = new BranchStore('session-1');
const branch = store.fork();
branch.set('context', state);
branch.set('memory', { note: 'accepted result' });
branch.commit();
const snapshot = store.snapshot(); // persist as JSON; restore with new BranchStore(id, snapshot)
```

State must be finite, acyclic JSON containing plain objects and dense arrays. Functions,
class instances, generators and live resources are rejected. Undefined object properties
are omitted. Scope, version and SHA-256 digest are checked on restore. The digest detects
accidental corruption, not malicious modification: authenticate untrusted stored state separately.

`BranchStore` is one in-process authority for explicit state namespaces. Forks share immutable
base values, reads/writes copy values, and each branch has a separate write set. `discard()`
closes a branch without changing its parent. `commit()` atomically applies all namespaces
only if the parent revision still matches; otherwise it throws a conflict. No implicit merge.
Snapshot persistence is the application's responsibility, including atomic file replacement.

Use this store for application-owned Context, Memory, artifact references and serializable
tool sessions. It does **not** snapshot Redis, SQL transactions, remote tools, processes or
filesystem writes. Applications must supply transactional adapters for those resources or
reject fork/cache operations. A new Runtime alone does not isolate external side effects.

## Graph and Loop recovery

Pass `{ checkpoint: { version, save, resume? } }` to `runtime.run(graph, input, options)`.
`save` receives a JSON `GraphCheckpoint` and is awaited at a quiescent boundary before more
Nodes start. Completed outputs are restored without executing their Nodes again. The graph
shape/binding text and input are hashed. The explicit `version` must additionally identify
configuration, captured closure values and resource snapshots, which cannot be introspected.
Checkpoint mode uses execution waves; ordinary execution retains its asynchronous scheduler.

Failures drain admitted Nodes and save an `uncertain` list. Automatic restoration refuses
those checkpoints because effects may have occurred. A crash after an external side effect
but before `save` is not exactly-once execution: use idempotency keys or resource transactions.
Do not retry a previous checkpoint against an already-mutated external resource.

For explicit-state Loops, pass `{ stateCheckpoint: { id, version, save, resume? } }` to
`runtime.loop`. Checkpoints contain the state after an iteration and the next iteration
index. Include the Loop definition/configuration in `version`. Generator-based plans reject
this option; a process cannot serialize a JavaScript generator. Inner Graphs may instead
have their own independent checkpoints.

## Shared accounting and admission

```js
import { TokenBudget, budgetedProvider } from '@codesoul-co/ditto';
const budget = new TokenBudget(100_000);
const metered = budgetedProvider(provider, budget, {
  reserveTokens: input => estimateUpperBound(input),
  scope: { runId: 'run-1', branchId: 'candidate-2', label: 'inference' },
  requireUsage: true,
});
// Register metered as a normal ModelProvider. Share budget across concurrent providers.
```

The application supplies `provider` and `estimateUpperBound`. The latter must bound the
entire request's input and maximum output, including protocol overhead and hidden reasoning.
An estimator without that guarantee is conservative admission, not a physical hard limit.
Budget reservations are synchronous and atomic within one JS process. Multi-process users
need a single shared admission authority; separate instances do not share limits.

Successful calls settle actual token usage. Failures/cancellation without usage charge the
full reservation and record `unknown`; pre-aborted calls are not admitted. Invalid/missing
usage also charges the reservation and `requireUsage` rejects it. Exceeding a reservation
records the actual charge, throws `BudgetExceededError` and closes further admission.
No already-incurred provider cost can be undone. Records preserve supplied usage (including
provider cache fields), reservation, charge, status and scope. Store logical replay costs
separately; replaying a checkpoint does not consume this budget. This wrapper uses `invoke`
and intentionally leaves streaming to the normal invoke fallback.
