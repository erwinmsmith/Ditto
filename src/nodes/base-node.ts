import type { InputOf, L2NodeType, OutputOf } from "../contracts/index.js";

export abstract class BaseNode<TNode extends L2NodeType> {
  abstract readonly type: TNode;

  abstract execute(input: InputOf<TNode>): Promise<OutputOf<TNode>>;
}

