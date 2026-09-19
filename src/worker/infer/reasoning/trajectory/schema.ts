import { common, messagesAndActions, object, text, number, check } from "../../validation.js";
import type { TrajectoryInput } from "./types.js";
export function validateTrajectory(input: unknown): asserts input is TrajectoryInput {
  const v = common(input); messagesAndActions(v);
  check(v.actions === undefined, "TRAJECTORY does not execute actions; use runReactFlow at Runtime level");
  const s = object(v.strategy, "strategy"); text(s.name, "strategy.name");
  if (s.options !== undefined) object(s.options, "strategy.options");
  if (v.objective !== undefined) text(v.objective, "objective", true);
  if (v.constraints !== undefined) {
    const c = object(v.constraints, "constraints");
    for (const key of ["maxSteps", "maxTotalTokens", "timeoutMs"]) {
      if (c[key] !== undefined) number(c[key], key, 1, key === "timeoutMs" ? 2 ** 31 - 1 : Number.MAX_SAFE_INTEGER, true);
    }
  }
}
