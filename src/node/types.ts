import type { InputOf, L2NodeType, OutputOf } from "../contracts/index.js";
import type { ArtifactStore } from "../runtime/artifact.js";
import type { RuntimeEvent } from "../runtime/events.js";

/** NodeContractMap can be augmented by an experiment without editing Core. */
export type NodeType = Extract<L2NodeType, `${string}.${string}`>;
export type WorkerType = NodeType extends `${infer W}.${string}` ? W : never;
export type BuiltinWorkerType = "REASONING" | "CONTEXT" | "MEMORY" | "INTERACTION";
export type NodesOfWorker<W extends WorkerType> = Extract<NodeType, `${W}.${string}`>;

export interface RuntimeClient {
  invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>): Promise<OutputOf<N>>;
  emit<T>(event: RuntimeEvent<T>): Promise<void>;
}

/** Execution services are a separate argument; never part of a Node input. */
export interface WorkerContext<R = undefined, C = undefined> extends RuntimeClient {
  readonly resources: R;
  readonly config: C;
  readonly artifacts: ArtifactStore | undefined;
}

export type NodeHandler<N extends NodeType, R = undefined, C = undefined> = (
  input: InputOf<N>,
  context: WorkerContext<R, C>,
) => Promise<OutputOf<N>>;

export interface NodeDefinition<N extends NodeType, R = undefined, C = undefined> {
  readonly type: N;
  readonly execute: NodeHandler<N, R, C>;
}

export function workerTypeOf(node: NodeType): WorkerType {
  const separator = node.indexOf(".");
  if (separator <= 0 || separator === node.length - 1) {
    throw new Error(`Expected a fully qualified Node Type: ${node}`);
  }
  return node.slice(0, separator) as WorkerType;
}
