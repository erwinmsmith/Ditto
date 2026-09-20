import { validateInput } from "../validation.js";
import type { MemoryUpdateInput } from "./types.js";
export function validateUpdate(value: unknown): asserts value is MemoryUpdateInput { validateInput("update", value); }
