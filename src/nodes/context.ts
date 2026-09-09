import { BaseNode } from "./base-node.js";

export abstract class ContextLoadNode extends BaseNode<"CONTEXT.LOAD"> {}
export abstract class ContextSelectNode extends BaseNode<"CONTEXT.SELECT"> {}
export abstract class ContextUpdateNode extends BaseNode<"CONTEXT.UPDATE"> {}
export abstract class ContextCompressNode extends BaseNode<"CONTEXT.COMPRESS"> {}
export abstract class ContextResetNode extends BaseNode<"CONTEXT.RESET"> {}

