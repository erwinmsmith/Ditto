import type { TrajectoryStrategy } from "./types.js";
import { cot } from "./cot.js";
import { tot } from "./tot.js";
import { got } from "./got.js";
import { selfConsistency } from "./self-consistency.js";
export type * from "./types.js";
export const builtInStrategies: Readonly<Record<string, TrajectoryStrategy>> = Object.freeze({
  cot, "long-cot": cot, tot, got, "self-consistency": selfConsistency,
});
