import type { ExecutionGraph } from "./graph.js";

/** Each iteration executes one selected DAG; the application owns state and termination. */
export interface LoopDefinition<S, I, O extends object> {
  /** A fixed Graph, or a selector choosing one candidate Graph from current state. */
  readonly graph: ExecutionGraph<I, O> | ((state: S) => ExecutionGraph<I, O>);
  readonly maxIterations?: number;
  readonly bind: (state: S) => I;
  readonly update: (state: S, output: O) => S;
  readonly done: (state: S, output: O) => boolean;
}

export function loop<S, I, O extends object>(definition: LoopDefinition<S, I, O>): LoopDefinition<S, I, O> {
  return Object.freeze({ ...definition });
}

export async function runLoop<S, I, O extends object>(
  definition: LoopDefinition<S, I, O>,
  initialState: NoInfer<S>,
  run: (graph: ExecutionGraph<I, O>, input: I) => Promise<O>,
): Promise<S> {
  const { graph, bind, update, done, maxIterations = 32 } = definition;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }
  let state = initialState;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const plan = typeof graph === "function" ? graph(state) : graph;
    const output = await run(plan, bind(state));
    state = update(state, output);
    if (done(state, output)) return state;
  }
  throw new Error("Loop iteration limit reached");
}
