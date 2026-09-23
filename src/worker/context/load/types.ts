import type { Context, ContextSource } from "../../../contracts/common.js";

export interface ContextLoadInput {
  /** Explicitly resolve bare Reference sources using the injected resolver. */
  readonly resolveReferences?: boolean;
  readonly sources: readonly ContextSource[];
}

export type ContextLoadOutput = Context;
