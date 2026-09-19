import type { TrajectoryStrategy } from "./types.js";
import { option } from "./cot.js";
import { InferError, modelOutput, parseOutput, text } from "../../../validation.js";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function answerKey(answer: string): string {
  try { return JSON.stringify(canonical(JSON.parse(answer))) as string; }
  catch { return answer.normalize("NFKC").trim().replace(/\s+/g, " "); }
}
/** Independent solution samples followed by deterministic voting on their final answers. */
export const selfConsistency: TrajectoryStrategy = async ctx => {
  const count = option(ctx.input.strategy.options?.candidates, 3, "candidates");
  const votes = new Map<string, { answer: string; count: number }>(); const parents: string[] = [];
  for (let i = 0; i < count; i++) {
    const sampled = await ctx.sample([...ctx.messages, { role: "user", content: 'Solve the original task independently. Return only JSON {"solutionSummary":string,"answer":string}. First give a concise calculation or constraint check in solutionSummary. The answer string must contain the final answer in the original requested format, without added explanation or private reasoning.' }], { summary: `Independent solution ${i + 1}` });
    const parsed = parseOutput(sampled.message.content); modelOutput(() => text(parsed.answer, "answer"));
    const answer = parsed.answer as string; const key = answerKey(answer);
    const vote = votes.get(key) ?? { answer, count: 0 }; vote.count++; votes.set(key, vote); parents.push(sampled.stepId);
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
  if (ranked.length > 1 && ranked[0]!.count === ranked[1]!.count) throw new InferError("NO_CONSENSUS", "Independent samples tied; no unique most frequent answer");
  const result = { role: "assistant" as const, content: ranked[0]!.answer };
  ctx.step({ type: "decision", message: result, parentIds: parents, summary: `Selected most frequent answer (${ranked[0]!.count}/${count})` });
  return result;
};
