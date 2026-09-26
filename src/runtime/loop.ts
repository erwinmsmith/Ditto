import type { LoopPlanDefinition } from "./graph-plan.js";
import type { ExecutionGraph } from "./graph.js";
import { checkpointState, restoreState, type LoopCheckpointOptions } from "./checkpoint.js";

/** Each iteration executes one selected DAG; the application owns state and termination. */
export interface LoopDefinition<S, I, O extends object> {
  /** A fixed Graph, or a selector choosing one candidate Graph from current state. */
  readonly graph: ExecutionGraph<I, O> | ((state: S) => ExecutionGraph<I, O>);
  readonly maxIterations?: number;
  readonly bind: (state: S) => I;
  readonly update: (state: S, output: O) => S;
  readonly done: (state: S, output: O) => boolean;
}

export function loop<I, R>(
  definition: LoopPlanDefinition<I, R>,
): LoopPlanDefinition<I, R>;
export function loop<S, I, O extends object>(
  definition: LoopDefinition<S, I, O>,
): LoopDefinition<S, I, O>;
export function loop(definition: object): object {
  return Object.freeze({ ...definition });
}

export async function runLoop<S, I, O extends object>(
  definition: LoopDefinition<S, I, O>,
  initialState: NoInfer<S>,
  run: (graph: ExecutionGraph<I, O>, input: I) => Promise<O>,
  signal?: AbortSignal,
  checkpoint?: LoopCheckpointOptions,
): Promise<S> {
  const { graph, bind, update, done, maxIterations = 32 } = definition;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new Error("maxIterations must be a positive integer");
  }
  const restored = checkpoint?.resume ? restoreState(checkpoint.resume, `loop:${checkpoint.id}`, checkpoint.version) : undefined;
  if (restored && (!Number.isSafeInteger(restored.iteration) || restored.iteration < 0 || restored.iteration > maxIterations))
    throw new Error("Invalid loop checkpoint iteration");
  let state = restored ? restored.state as S : initialState;
  if (restored?.completed) return state;
  for (let iteration = restored?.iteration ?? 0; iteration < maxIterations; iteration++) {
    signal?.throwIfAborted();
    const plan = typeof graph === "function" ? graph(state) : graph;
    const output = await run(plan, bind(state));
    signal?.throwIfAborted();
    state = update(state, output);
    const completed = done(state, output);
    if (checkpoint) await checkpoint.save(checkpointState(`loop:${checkpoint.id}`, checkpoint.version,
      { iteration: iteration + 1, state, completed }));
    if (completed) return state;
  }
  throw new Error("Loop iteration limit reached");
}
