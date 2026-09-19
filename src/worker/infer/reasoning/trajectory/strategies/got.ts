import type { Message } from "../../../types.js";
import type { TrajectoryStrategy } from "./types.js";
import { option } from "./cot.js";
/** Layered graph: branch, aggregate all parents, then feed the merged state into the next layer. */
export const got: TrajectoryStrategy = async ctx => {
  const breadth = option(ctx.input.strategy.options?.breadth, 3, "breadth");
  const depth = option(ctx.input.strategy.options?.depth, 2, "depth");
  let shared: Message | undefined; let parentIds: string[] = [];
  for (let level = 0; level < depth; level++) {
    const candidates = [];
    for (let branch = 0; branch < breadth; branch++) {
      const response = await ctx.sample([...ctx.messages, ...(shared ? [shared] : []), { role: "user", content: `Contribute perspective ${branch + 1}/${breadth} at graph layer ${level + 1}/${depth}. Independently solve or check part of the original task, contributing a complementary, concise result. Use the shared aggregate if present, and correct any errors. At the final layer provide a complete candidate answer in the original format.` }], { parentIds, summary: `Expand graph layer ${level + 1}, contribution ${branch}` });
      candidates.push({ id: `${level}:${branch}`, result: response.message, stepId: response.stepId });
    }
    const decision = await ctx.deliberate(candidates.map(({ id, result }) => ({ id, result })), "merge", { parentIds: candidates.map(c => c.stepId), summary: "Aggregate complementary parents, resolve conflicts against the original task" });
    shared = decision.result;
    const merged = ctx.step({ type: "decision", message: shared, parentIds: [decision.stepId], summary: decision.decisionSummary ?? "Merged graph contributions" });
    parentIds = [merged.id];
  }
  return shared!;
};
