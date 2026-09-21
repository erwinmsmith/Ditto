import type { Context, ContextSource } from "../../../contracts/common.js";

export interface ContextLoadInput {
  readonly sources: readonly ContextSource[];
}

export type ContextLoadOutput = Context;
