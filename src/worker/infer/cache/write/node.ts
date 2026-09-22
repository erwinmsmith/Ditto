import type { InferExecution } from "../../execution.js";
import type { CacheWriteInput, CacheWriteOutput } from "./types.js";
import { validateWrite } from "./schema.js";
import { abortable } from "../../validation.js";
export async function writeNode(input: CacheWriteInput, ctx: InferExecution): Promise<CacheWriteOutput> {
  validateWrite(input); return abortable(() => ctx.cache.write(input, { signal: ctx.signal }), ctx.signal);
}
