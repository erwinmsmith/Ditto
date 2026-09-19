import type { InferExecution } from "../../execution.js";
import type { CacheLookupInput, CacheLookupOutput } from "./types.js";
import { validateLookup } from "./schema.js";
import { abortable } from "../../validation.js";
export async function lookupNode(input: CacheLookupInput, ctx: InferExecution): Promise<CacheLookupOutput> {
  validateLookup(input); return abortable(() => ctx.cache.lookup(input), ctx.signal);
}
