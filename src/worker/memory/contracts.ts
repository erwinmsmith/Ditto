import type { NodeResult } from "../../contracts/node-result.js";
import type { MemoryGetInput, MemoryGetOutput } from "./get/types.js";
import type { MemoryQueryInput, MemoryQueryOutput } from "./query/types.js";
import type { MemorySearchInput, MemorySearchOutput } from "./search/types.js";
import type { MemoryWriteInput, MemoryWriteOutput } from "./write/types.js";
import type { MemoryUpdateInput, MemoryUpdateOutput } from "./update/types.js";
import type { MemoryDeleteInput, MemoryDeleteOutput } from "./delete/types.js";

export type * from "./get/types.js";
export type * from "./query/types.js";
export type * from "./search/types.js";
export type * from "./write/types.js";
export type * from "./update/types.js";
export type * from "./delete/types.js";
export type * from "./types.js";

export interface MemoryContractMap {
  "MEMORY.GET": { input: MemoryGetInput; output: MemoryGetOutput };
  "MEMORY.QUERY": { input: MemoryQueryInput; output: MemoryQueryOutput };
  "MEMORY.SEARCH": { input: MemorySearchInput; output: MemorySearchOutput };
  "MEMORY.WRITE": { input: MemoryWriteInput; output: MemoryWriteOutput };
  "MEMORY.UPDATE": { input: MemoryUpdateInput; output: MemoryUpdateOutput };
  "MEMORY.DELETE": { input: MemoryDeleteInput; output: MemoryDeleteOutput };
}
export type MemoryNode = keyof MemoryContractMap;
export type MemoryInput<N extends MemoryNode> = MemoryContractMap[N]["input"];
export type MemoryOutput<N extends MemoryNode> = MemoryContractMap[N]["output"];
type RuntimeContracts = { [N in MemoryNode]: { input: MemoryInput<N>; output: NodeResult<MemoryOutput<N>> } };
declare module "../../contracts/node-contract-map.js" { interface NodeContractMap extends RuntimeContracts {} }
