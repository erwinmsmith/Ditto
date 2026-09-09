import { BaseNode } from "./base-node.js";

export abstract class InteractionActNode extends BaseNode<"INTERACTION.ACT"> {}
export abstract class InteractionObserveNode extends BaseNode<"INTERACTION.OBSERVE"> {}
export abstract class InteractionCommunicateNode extends BaseNode<"INTERACTION.COMMUNICATE"> {}
export abstract class InteractionOutputNode extends BaseNode<"INTERACTION.OUTPUT"> {}

