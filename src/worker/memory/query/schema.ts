import { validateInput } from "../validation.js";
import type { MemoryQueryInput } from "./types.js";
export function validateQuery(value: unknown): asserts value is MemoryQueryInput { validateInput("query", value); }
