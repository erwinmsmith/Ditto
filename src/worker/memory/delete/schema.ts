import { validateInput } from "../validation.js";
import type { MemoryDeleteInput } from "./types.js";
export function validateDelete(value: unknown): asserts value is MemoryDeleteInput { validateInput("delete", value); }
