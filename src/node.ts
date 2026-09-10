import type { InputOf, L2NodeType, OutputOf } from "./contracts/index.js";
import type { ArtifactStore } from "./runtime/artifact.js";
import type { RuntimeEvent } from "./runtime/events.js";
import type { ExecutionGraph } from "./runtime/graph.js";
import type { RuntimeServices } from "./runtime/services.js";
import type { ExecutionScope, WorkerAddress } from "./runtime/transport.js";

/** NodeContractMap can be augmented by an experiment without editing Core. */
export type NodeType = Extract<L2NodeType, `${string}.${string}`>;
/** Deployment role; independent of the semantic Node namespace. */
export type WorkerType = string;

export interface RuntimeClient {
  invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>): Promise<OutputOf<N>>;
  emit<T>(event: RuntimeEvent<T>): Promise<void>;
}

/** Execution services are a separate argument; never part of a Node input. */
export interface WorkerContext<R = undefined, C = undefined> extends RuntimeClient {
  readonly resources: R;
  readonly config: C;
  readonly artifacts: ArtifactStore | undefined;
  readonly services: RuntimeServices;
  readonly worker: WorkerAddress;
  readonly execution: ExecutionScope | undefined;
  /** Execute an internal graph entirely on this Worker replica. */
  run<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>): Promise<O>;
}

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
