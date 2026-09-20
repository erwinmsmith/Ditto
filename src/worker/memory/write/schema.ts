import { validateInput } from "../validation.js";
import type { MemoryWriteInput } from "./types.js";
export function validateWrite(value: unknown): asserts value is MemoryWriteInput { validateInput("write", value); }
