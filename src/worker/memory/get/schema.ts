import { validateInput } from "../validation.js";
import type { MemoryGetInput } from "./types.js";
export function validateGet(value: unknown): asserts value is MemoryGetInput { validateInput("get", value); }
