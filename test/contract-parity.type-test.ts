import type * as Current from "../src/index.js";
import type * as Reviewed from "./reference-contract.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// All 18 reviewed contracts must match, including nested fields and readonly.
// Experiment-owned module augmentations are intentionally outside this check.
export type ContractParity = Expect<Equal<
  Pick<Current.NodeContractMap, keyof Reviewed.NodeContractMap>, Reviewed.NodeContractMap
>>;
export type ReferenceParity = Expect<Equal<Current.Reference, Reviewed.Reference>>;
export type MessageParity = Expect<Equal<Current.Message, Reviewed.Message>>;
export type JsonParity = Expect<Equal<Current.JsonValue, Reviewed.JsonValue>>;
