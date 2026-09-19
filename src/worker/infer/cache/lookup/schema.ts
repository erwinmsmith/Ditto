import { object } from "../../validation.js";
import { cacheKey } from "../schema.js";
import type { CacheLookupInput } from "./types.js";
export function validateLookup(input: unknown): asserts input is CacheLookupInput { cacheKey(object(input).key); }
