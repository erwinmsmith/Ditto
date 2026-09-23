import type { InferExecution } from "../../execution.js";
import type { CacheInvalidateInput, CacheInvalidateOutput } from "./types.js";
import { validateInvalidate } from "./schema.js";
import { abortable } from "../../validation.js";
export async function invalidateNode(input: CacheInvalidateInput, ctx: InferExecution): Promise<CacheInvalidateOutput> {
  validateInvalidate(input); return abortable(() => ctx.cache.invalidate(input, { signal: ctx.signal }), ctx.signal);
}
