import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type { WorkerContext } from "./execution-context.js";
export type { RuntimeClient, WorkerContext } from "./execution-context.js";

/** Deployment/resource boundary; intentionally independent from Node namespace. */
export type WorkerType = string;

export type NodeHandler<N extends NodeType, R = undefined, C = undefined> = (
  input: InputOf<N>,
  context: WorkerContext<R, C>,
) => Promise<OutputOf<N>>;

export interface NodeDefinition<N extends NodeType, R = undefined, C = undefined> {
  readonly workerType: WorkerType;
  readonly type: N;
  readonly execute: NodeHandler<N, R, C>;
}

export function defineNode<N extends NodeType, R = undefined, C = undefined>(
  workerType: WorkerType,
  type: N,
  execute: NodeHandler<NoInfer<N>, R, C>,
): NodeDefinition<N, R, C> {
  if (typeof workerType !== "string" || !workerType.trim()) throw new Error("Node requires an owning Worker type");
  if (typeof type !== "string" || !/^[^.\s]+(?:\.[^.\s]+)+$/.test(type)) {
    throw new Error("Node type must be a fully qualified leaf name");
  }
  if (typeof execute !== "function") throw new Error(`Missing handler for ${type}`);
  return Object.freeze({ workerType, type, execute });
}
