import type { Context } from "../../../contracts/common.js";

export interface ContextCompressInput {
  readonly context: Context;
  readonly maxTokens?: number;
  readonly maxItems?: number;
}

export type ContextCompressOutput = Context;
