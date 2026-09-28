# Graph and Loop: dependencies and dynamic execution

A Graph is an immutable directed acyclic graph describing data dependencies within a stage. A Loop controls the order, branching and repetition of Graphs. An Agent may have several stage Graphs while exposing one `runtime.loop` call.

## 1. The four arguments of a node

```ts
const plan = graph<string>("question-context")
  .node("loaded", "CONTEXT.LOAD", [], question => ({
    sources: [{ role: "user", content: question }],
  }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (_question, { loaded }) => ({
    context: loaded, purpose: "infer", limit: 8,
  }));
```

| Argument | Meaning | Common mistake |
| --- | --- | --- |
| `loaded` | Unique result ID within this Graph | Confusing it with a global Node type or reusing an ID |
| `CONTEXT.LOAD` | Routable semantic leaf | Calling a namespace such as `CONTEXT` or `INFER.REASONING` |
| `[]` / `["loaded"]` | Results that must complete first | Reading undeclared dependencies in the binder |
| `(input, outputs) => payload` | Builds input from Graph input and dependencies | Performing database or network actions inside the binder |

`.node()` returns a new Graph without modifying the existing one. Graphs do not contain database instances, API keys or server addresses. Model selection can be controlled input data; credentials stay in Worker resource configuration.

## 2. Sequence, parallelism and joins

```text
request → load → select → infer → output
request → search-a ─┐
        → search-b ─┴→ combine → infer
```

Independent nodes can become ready together. A join explicitly depends on both branches. `runtime.run(plan,input,{concurrency:2})` limits concurrent nodes in that Graph. Worker `concurrency` separately limits entry calls per replica; it is not an unbounded waiting queue.

A Graph does not automatically throw for `{status:"failed"}`. Downstream binders must check the return contract. If a node throws, the scheduler stops launching subsequent nodes; completed external actions are not undone. To retain partial successes, return inspectable action outcomes and aggregate them explicitly.

## 3. Compose stages through a Loop

Save this complete JavaScript example as `loop.mjs`. It only requires the main package:

```js
import { createDitto, createContextWorker, graph, graphStep, loop } from "@codesoul-co/ditto";
const load = graph("load")
  .node("context", "CONTEXT.LOAD", [], text => ({ sources: [{ role: "user", content: text }] }));
const select = graph("select")
  .node("selection", "CONTEXT.SELECT", [], context => ({ context, purpose: "infer", limit: 1 }));
const plan = loop({
  id: "prepare-question", maxIterations: 2,
  *plan(question) {
    const loaded = yield* graphStep(load, question);
    const selected = yield* graphStep(select, loaded.context);
    return selected.selection;
  },
});
const runtime = createDitto({ workers: [createContextWorker()] });
try { console.log(JSON.stringify(await runtime.loop(plan, "Hello Ditto"), null, 2)); }
finally { await runtime.close(); }
```

`maxIterations:2` allows two Graph executions in total, not two per stage. Failed Graphs count as executions. The plan yields Graph invocations; the generator itself does not open files, call SDKs or run `runtime.run`.

## 4. Conditions, retries and replanning

After receiving a stage result, use ordinary conditions to select the next Graph:

```ts
// Wiring sketch: inspectGraph / executeGraph / reviewGraph are application-defined Graphs.
function* taskPlan(request: Request): GraphPlan<Result> {
  const inspected = yield* graphStep(inspectGraph, request);
  if (inspected.needsHuman) return { status: "waiting_for_human" };
  let state = inspected;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = yield* graphStep(executeGraph, state);
    const review = yield* graphStep(reviewGraph, result);
    if (review.complete) return { status: "completed", result };
    state = review.nextInput;
  }
  return { status: "budget_exhausted" };
}
```

The fragment illustrates application types and assumes the named Graphs already exist. For executable applications, see [dynamic iteration](../../examples/control-flow/iteration/README.md) and [Plan-and-Execute](../../examples/patterns/plan-and-execute/README.md).

Before retrying, distinguish invalid input, temporary infrastructure errors and committed side effects. Changing the plan does not reset budgets. The outer Loop owns cancellation; do not swallow cancellation and continue with more Graphs.

## 5. Repeat a fixed Graph

For lists or fixed iterations, use a state-based Loop:

```ts
const definition = loop({
  graph: oneItemGraph,
  maxIterations: items.length,
  bind: (index: number) => items[index]!,
  update: index => index + 1,
  done: index => index === items.length,
});
// Return immediately for an empty list; do not create a maxIterations=0 Loop.
```

Return immediately for an empty list rather than creating a Loop with `maxIterations=0`. When stages have different input/output types, generator-based `graphStep` preserves type inference across stages.

## 6. Subplans and execution budgets

A reusable subplan is a generator function. The parent calls `yield* childPlan(input)` and the child yields `graphStep` invocations. All Graphs count against the same outer Loop budget. Starting a separate Runtime/Loop in each child disconnects cancellation, counting and lifecycle management.

A Worker may use `ctx.run(internalGraph,input)` for its private implementation. This does not replace the application's Loop or imply that complete Agents should be hidden inside Workers. See [Worker extensions](extensions.en.md).

## 7. Observe and stop execution

Pass `{ signal: AbortSignal.timeout(120_000), onGraph: event => ... }` to `runtime.loop` to observe stage start, completion and failure. Record loopId, graphId, iteration and status, plus application task IDs and idempotency keys. Keep secrets and unredacted context out of logs.

[Graph/Loop API](../worker-api/graph-loops.md) · [Parallel execution](../worker-api/parallel.md) · [Recovery](reliability.en.md)
