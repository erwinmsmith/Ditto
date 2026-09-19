import type { Message } from "../../../types.js";
import type { TrajectoryStrategy } from "./types.js";
import { number } from "../../../validation.js";
export function option(value: unknown, fallback: number, name: string, max = 16): number {
  const result = value ?? fallback; number(result, name, 1, max, true); return result;
}
/** A linear reasoning path. Intermediate states are public summaries, never hidden provider reasoning. */
export const cot: TrajectoryStrategy = async ctx => {
  const rounds = option(ctx.input.strategy.options?.rounds, ctx.input.strategy.name === "long-cot" ? 4 : 2, "rounds", 64);
  const messages = [...ctx.messages]; let parentIds: string[] = [];
  let result: Message = { role: "assistant", content: "" };
  for (let i = 0; i < rounds; i++) {
    const final = i === rounds - 1;
    const instruction: Message = { role: "user", content: final
      ? "Solve the original task using the available intermediate results. Check the calculation and constraints, then return the final answer in the original requested format. If explanations are allowed, give only a brief solution summary."
      : `Advance the solution at stage ${i + 1} of ${rounds}. ${i === 0 ? "Compute a concise solution with the relevant equations or constraint checks and intermediate results." : "Use the previous intermediate results to solve the next subproblem and check the constraints."} Return a concise solution summary with the intermediate results.` };
    const response = await ctx.sample([...messages, instruction], { parentIds, summary: final ? "Conclude the linear reasoning path" : `Advance linear stage ${i + 1}` });
    result = response.message; parentIds = [response.stepId]; messages.push(instruction, result);
  }
  return result;
};
