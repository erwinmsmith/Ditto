import { BaseNode } from "./base-node.js";

export abstract class MemoryRetrieveNode extends BaseNode<"MEMORY.RETRIEVE"> {}
export abstract class MemoryWriteNode extends BaseNode<"MEMORY.WRITE"> {}
export abstract class MemoryUpdateNode extends BaseNode<"MEMORY.UPDATE"> {}
export abstract class MemoryConsolidateNode extends BaseNode<"MEMORY.CONSOLIDATE"> {}
export abstract class MemoryEvictNode extends BaseNode<"MEMORY.EVICT"> {}

