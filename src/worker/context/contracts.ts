import type { ContextLoadInput, ContextLoadOutput } from "./load/types.js";
import type { ContextSelectInput, ContextSelectOutput } from "./select/types.js";
import type { ContextUpdateInput, ContextUpdateOutput } from "./update/types.js";
import type { ContextCompressInput, ContextCompressOutput } from "./compress/types.js";

export type * from "./load/types.js";
export type * from "./select/types.js";
export type * from "./update/types.js";
export type * from "./compress/types.js";
export type * from "./types.js";

export interface ContextContractMap {
  "CONTEXT.LOAD": { input: ContextLoadInput; output: ContextLoadOutput };
  "CONTEXT.SELECT": { input: ContextSelectInput; output: ContextSelectOutput };
  "CONTEXT.UPDATE": { input: ContextUpdateInput; output: ContextUpdateOutput };
  "CONTEXT.COMPRESS": { input: ContextCompressInput; output: ContextCompressOutput };
}

export type ContextNode = keyof ContextContractMap;
export type ContextInput<N extends ContextNode> = ContextContractMap[N]["input"];
export type ContextOutput<N extends ContextNode> = ContextContractMap[N]["output"];

declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap extends ContextContractMap {}
}
