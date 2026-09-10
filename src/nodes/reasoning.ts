import { BaseNode } from "./base-node.js";

export abstract class InferNode extends BaseNode<"REASONING.INFER"> {}
export abstract class DeliberateNode extends BaseNode<"REASONING.DELIBERATE"> {}
export abstract class ReflectNode extends BaseNode<"REASONING.REFLECT"> {}
export abstract class SampleNode extends BaseNode<"REASONING.SAMPLE"> {}

