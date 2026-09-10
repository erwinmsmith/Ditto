import type { InputOf, L2NodeType, OutputOf } from "../contracts/index.js";

export type L1NodeType = "REASONING" | "CONTEXT" | "MEMORY" | "INTERACTION";

export type ReasoningNodeType = Extract<L2NodeType, `REASONING.${string}`>;
export type ContextNodeType = Extract<L2NodeType, `CONTEXT.${string}`>;
export type MemoryNodeType = Extract<L2NodeType, `MEMORY.${string}`>;
export type InteractionNodeType = Extract<L2NodeType, `INTERACTION.${string}`>;

export interface NodeRequest<TNode extends L2NodeType> {
  node: TNode;
  input: InputOf<TNode>;
}

export interface NodeResponse<TNode extends L2NodeType> {
  node: TNode;
  output: OutputOf<TNode>;
}

export abstract class BaseL1Node<TNode extends L2NodeType> {
  abstract execute<TSelected extends TNode>(
    request: NodeRequest<TSelected>,
  ): Promise<NodeResponse<TSelected>>;
}

export abstract class ReasoningNode extends BaseL1Node<ReasoningNodeType> {}
export abstract class ContextNode extends BaseL1Node<ContextNodeType> {}
export abstract class MemoryNode extends BaseL1Node<MemoryNodeType> {}
export abstract class InteractionNode extends BaseL1Node<InteractionNodeType> {}

