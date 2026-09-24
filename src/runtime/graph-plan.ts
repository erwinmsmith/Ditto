import type { ExecutionGraph, GraphRunOptions } from "./graph.js";

/** A Loop plan can only yield Graph invocations; it cannot execute a Worker itself. */
export interface GraphInvocation {
  readonly kind: "graph";
  readonly graph: ExecutionGraph<unknown, object>;
  readonly input: unknown;
  readonly options: GraphRunOptions;
}
export type GraphPlan<R> = Generator<GraphInvocation, R, unknown>;
export interface LoopPlanDefinition<I, R> {
  readonly id: string;
  readonly plan: (input: I) => GraphPlan<R>;
  /** Bounds Graph executions, including failed Graphs and repetitions. */
  readonly maxIterations?: number;
}
export interface LoopGraphEvent {
  readonly loopId: string;
  readonly iteration: number;
  readonly graphId: string;
  readonly nodes: readonly string[];
  readonly status: "started" | "completed" | "failed";
}
/** Yield a typed Graph to its owning Loop; returned values resume the plan. */
export function* graphStep<I, O extends object>(
  plan: ExecutionGraph<I, O>,
  input: NoInfer<I>,
  options: GraphRunOptions = {},
): GraphPlan<O> {
  const output = yield Object.freeze({
    kind: "graph" as const,
    graph: plan as ExecutionGraph<unknown, object>,
    input,
    options: Object.freeze({ ...options }),
  });
  return output as O;
}
export async function runGraphPlan<I, R>(
  definition: LoopPlanDefinition<I, R>,
  input: I,
  run: (
    graph: ExecutionGraph<unknown, object>,
    input: unknown,
    options: GraphRunOptions,
  ) => Promise<object>,
  signal?: AbortSignal,
  onGraph?: (event: LoopGraphEvent) => void,
): Promise<R> {
  const maximum = definition.maxIterations ?? 32;
  if (!definition.id.trim() || !Number.isSafeInteger(maximum) || maximum < 1)
    throw new Error("Loop ID and positive maxIterations are required");
  signal?.throwIfAborted();
  const iterator = definition.plan(input);
  let step: IteratorResult<GraphInvocation, R>;
  try {
    step = iterator.next();
    for (let iteration = 0; !step.done; iteration++) {
      signal?.throwIfAborted();
      if (iteration >= maximum) throw new Error("Loop iteration limit reached");
      const call = step.value;
      if (!call || call.kind !== "graph" || !call.graph?.tasks)
        throw new Error("Loop plan must yield graphStep invocations");
      const event = {
        loopId: definition.id,
        iteration,
        graphId: call.graph.id,
        nodes: call.graph.tasks.map((t) => t.id),
      };
      onGraph?.({ ...event, status: "started" });
      let output: object;
      try {
        output = await run(call.graph, call.input, call.options);
      } catch (error) {
        onGraph?.({ ...event, status: "failed" });
        signal?.throwIfAborted(); // Whole-Loop cancellation cannot be swallowed by a plan.
        step = iterator.throw(error);
        continue;
      }
      signal?.throwIfAborted();
      onGraph?.({ ...event, status: "completed" });
      step = iterator.next(output);
    }
    return step.value;
  } finally {
    // Run synchronous cleanup; never execute a yielded Graph after termination.
    iterator.return(undefined as R);
  }
}
