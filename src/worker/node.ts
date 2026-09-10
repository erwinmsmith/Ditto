import type { InputOf, L2NodeType, OutputOf } from "../contracts/index.js";
import type { WorkerContext } from "./execution-context.js";
export type { RuntimeClient, WorkerContext } from "./execution-context.js";

/** NodeContractMap can be augmented by an experiment without editing Core. */
export type NodeType = Extract<L2NodeType, `${string}.${string}`>;
/** Deployment role; independent of the semantic Node namespace. */
export type WorkerType = string;

export type NodeHandler<N extends NodeType, R = undefined, C = undefined> = (
  input: InputOf<N>,
  context: WorkerContext<R, C>,
) => Promise<OutputOf<N>>;

export interface NodeDefinition<N extends NodeType, R = undefined, C = undefined> {
  readonly type: N;
  readonly execute: NodeHandler<N, R, C>;
}

export function defineNode<N extends NodeType, R = undefined, C = undefined>(
  type: N,
  execute: NodeHandler<NoInfer<N>, R, C>,
): NodeDefinition<N, R, C> {
  return Object.freeze({ type, execute });
}
