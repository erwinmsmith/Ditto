import type { NodeContract, NodeResult } from "@codesoul-co/ditto/contracts";
import type { RetrievalSearchInput, RetrievalSearchOutput } from "./search/types.js";
export type * from "./types.js";
export type * from "./search/types.js";

// The optional package adds its leaf contract when consumers import it.
declare module "@codesoul-co/ditto/contracts" {
  interface NodeContractMap {
    "RETRIEVAL.SEARCH": NodeContract<RetrievalSearchInput, NodeResult<RetrievalSearchOutput>>;
  }
}
