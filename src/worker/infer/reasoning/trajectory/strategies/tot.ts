import type { Message } from "../../../types.js";
import type { TrajectoryStrategy } from "./types.js";
import { option } from "./cot.js";
/** Bounded breadth-first beam search: expand every retained state, rank, then prune. */
export const tot: TrajectoryStrategy = async ctx => {
  const breadth = option(ctx.input.strategy.options?.breadth, 3, "breadth");
  const depth = option(ctx.input.strategy.options?.depth, 2, "depth");
  const beamWidth = option(ctx.input.strategy.options?.beamWidth, 2, "beamWidth");
  let frontier: { messages: Message[]; stepId?: string }[] = [{ messages: ctx.messages }];
  let result: Message = { role: "assistant", content: "" };
  for (let level = 0; level < depth; level++) {
    const candidates: { id: string; result: Message; stepId: string; messages: Message[] }[] = [];
    for (const [parentIndex, parent] of frontier.entries()) {
      for (let branch = 0; branch < breadth; branch++) {
        const instruction: Message = { role: "user", content: `Explore alternative ${branch + 1}/${breadth} from this state at search depth ${level + 1}/${depth}. Use a distinct approach. ${level === depth - 1 ? "Return a complete answer in the original requested format." : "Return a concise intermediate solution state with enough information to continue."} Respect the original problem and constraints.` };
        const response = await ctx.sample([...parent.messages, instruction], { parentIds: parent.stepId ? [parent.stepId] : [], summary: `Expand tree level ${level + 1}, parent ${parentIndex}, branch ${branch}` });
        candidates.push({ id: `${level}:${parentIndex}:${branch}`, result: response.message, stepId: response.stepId, messages: [...parent.messages, instruction, response.message] });
      }
    }
    const count = level === depth - 1 ? 1 : Math.min(beamWidth, candidates.length);
    const decision = await ctx.deliberate(candidates.map(({ id, result }) => ({ id, result })), "select", {
      selectCount: count, parentIds: candidates.map(c => c.stepId), summary: `Rank tree frontier; retain ${count} state(s)`,
    });
    const selected = decision.selectedCandidateIds!.map(id => candidates.find(c => c.id === id)!);
    result = selected[0]!.result;
    ctx.step({ type: "decision", message: result, parentIds: [decision.stepId], summary: `Retained ${selected.map(c => c.id).join(", ")}` });
    frontier = selected.map(c => ({ messages: c.messages, stepId: c.stepId }));
  }
  return result;
};
