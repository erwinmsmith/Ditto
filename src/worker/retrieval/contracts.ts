import type { NodeResult } from "../../contracts/node-result.js";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./search/types.js";
export type * from "./types.js";
export type * from "./search/types.js";

// This augmentation is reachable from the optional subpath, not Core's public entry.
declare module "../../contracts/node-contract-map.js" {
  interface NodeContractMap {
    "RETRIEVAL.SEARCH": NodeContract<RetrievalSearchInput, NodeResult<RetrievalSearchOutput>>;
  }
}
