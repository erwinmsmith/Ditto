import type { MemoryItem } from "../types.js";
export interface MemoryGetInput { ids?: readonly string[]; keys?: readonly string[]; }
export type MemoryGetOutput = readonly MemoryItem[];
