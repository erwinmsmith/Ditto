import type { NodeDefinition, NodeHandler, NodeType } from "./types.js";

export function defineNode<N extends NodeType, R = undefined, C = undefined>(
  type: N,
  execute: NodeHandler<NoInfer<N>, R, C>,
): NodeDefinition<N, R, C> {
  return Object.freeze({ type, execute });
}
