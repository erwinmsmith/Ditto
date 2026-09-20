import { validateInput } from "../validation.js";
import type { MemorySearchInput } from "./types.js";
export function validateSearch(value: unknown): asserts value is MemorySearchInput { validateInput("search", value); }
