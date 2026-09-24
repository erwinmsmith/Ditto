# Composing Graphs through Loop

[简体中文](graph-loops.zh-CN.md) · [Runtime API](runtime.md) · [RAG application](../../examples/patterns/rag-qa/README.md)

A Graph describes nodes and dependencies within a stage. Loop composes one or more Graphs and owns their order, branching, repetition and termination. Graphs do not contain child Graphs or embedded Loop nodes.

## Loop definitions

The existing `loop({graph, bind, update, done, maxIterations})` state-machine interface remains compatible. Each iteration executes a fixed or state-selected Graph, updates state from its output, then checks termination.

For heterogeneous stages and reusable recovery/checkpoint logic, define a synchronous execution plan:

```ts
import { createDitto, graph, graphStep, loop } from "@ditto/core/runtime";
import { createContextWorker, createInMemoryContextStore } from "@ditto/core/worker/context";

// This small orchestration example uses explicit test Context; full Agents use Redis.
const runtime = createDitto({ workers: [createContextWorker({
  services: { stateStore: createInMemoryContextStore() }
})] });
const load = graph<{ question: string }>("load-question")
  .node("context", "CONTEXT.LOAD", [], input => ({
    sources: [{ id: "question", content: input.question }]
  }));
const select = graph<{ context: import("@ditto/core/contracts").Context }>("select-context")
  .node("selected", "CONTEXT.SELECT", [], input => ({
    context: input.context, purpose: "infer", limit: 1
  }));
const workflow = loop({
  id: "question-workflow",
  maxIterations: 4,
  plan: function* (input: { question: string }) {
    const loaded = yield* graphStep(load, input);
    const result = yield* graphStep(select, { context: loaded.context });
    return result.selected.context;
  }
});
try {
  const result = await runtime.loop(workflow, { question: "How do I borrow equipment?" }, {
    onGraph: event => console.log(event.graphId, event.status)
  });
  console.log(result);
} finally { await runtime.close(); }
```

`graphStep` yields a Graph and typed input to Loop, which executes it through Runtime and resumes the plan with the typed output. Plans do not call `runtime.run()`, execute Workers, or perform model/database/network/file effects themselves.

An `if` selects the next Graph from prior results; a `for` can yield the same Graph repeatedly. Loop/Runtime own actual execution, iteration budgets, cancellation, Worker placement and lifecycle. Reusable `function*` subplans compose with `yield* childPlan()` inside the same Loop and budget.

## API contracts

| API | Contract |
| --- | --- |
| `GraphPlan<R>` | Synchronous generator yielding only Graph invocations and returning R |
| `graphStep<I,O>(graph,input,options?)` | Typed input I, returned output O; optional GraphRunOptions |
| `LoopPlanDefinition<I,R>` | `{id, plan:(input:I)=>GraphPlan<R>, maxIterations?}` |
| `runtime.loop(definition,input,options?)` | Runs the plan and returns `Promise<R>` |
| `LoopRunOptions.workers` | Existing per-Graph/per-node Worker bindings |
| `LoopRunOptions.onGraph` | Plan-Loop events: loopId, iteration, graphId, nodes, status |

Statuses are `started`, `completed`, `failed`; iteration starts at zero. Every executed Graph, including failures, consumes one iteration. A completed Graph may contain unsuccessful business NodeResults, which still require validation. Events describe the dynamic execution trace, not a statically enumerated DAG of all possible branches. Keep observer callbacks lightweight; thrown observer errors terminate the Loop.

Omitted `maxIterations` uses Runtime `loopMaxIterations`. Per-step concurrency controls nodes within that Graph. A plan yields one Graph at a time; independent node parallelism belongs in a Graph.

## Errors, cancellation and recovery

Thrown Graph errors are delivered to the corresponding `yield* graphStep`. Catch only allowed recovery conditions, such as an absent Context cache; connection errors must propagate. A failed NodeResult remains returned data and must be checked by the application.

The signal passed to `runtime.loop` cancels the whole Loop and cannot be swallowed by a plan. A step signal can represent a stage deadline whose error is caught to run an explicit failure-recording Graph. Whole-Loop and step signals are combined; a step cannot override the enclosing cancellation signal.

Budget exhaustion terminates the Loop and cannot be caught to continue execution. Termination closes the generator; synchronous finally cleanup runs, but Graphs yielded during cleanup are not executed. Reserve budget and use ordinary error branches for compensation or business failure recording. Runtime.close drains accepted Loops and active Graphs before disposing Workers.

Loop does not persist generator stacks or replay side effects automatically. Applications use public Memory Graphs for durable stage results. A new process restarts the plan, reads checkpoints and skips completed work while retaining permission checks, Redis reconstruction, effect reconciliation and idempotent delivery.

The RAG module exports `runRagLoop`; each capability exports its `run*Loop`. Their convenience `run*()` functions invoke one `runtime.loop()`. Checkpoint, model, retrieval, tool and delivery Graphs are all scheduled by that Loop. Separate trusted-controller ingestion can still invoke an individual Graph directly.
