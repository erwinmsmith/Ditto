export type * from "./lookup/types.js";
export type * from "./write/types.js";
export type * from "./invalidate/types.js";
export type * from "./types.js";

/** Namespace only; dispatch uses LOOKUP, WRITE or INVALIDATE. */
export const INFER_CACHE_NAMESPACE = "INFER.CACHE" as const;
