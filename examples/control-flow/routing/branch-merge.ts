import { graph } from "@codesoul-co/ditto/runtime";
import { cli, isMain, json, validateRequest, type Request, type Runner } from "./shared.ts";

export const mergeGraph = graph<Request>("branch-merge")
  .node("owner", "INFER.REASONING.SAMPLE", [], input => ({
    model: input.model, messages: [
      { role: "system", content: 'Extract the owner identifier exactly. Return ONLY JSON {"owner":string}.' },
      { role: "user", content: input.text },
    ],
  }))
  .node("deadline", "INFER.REASONING.SAMPLE", [], input => ({
    model: input.model, messages: [
      { role: "system", content: 'Extract the deadline date exactly. Return ONLY JSON {"deadline":string} in YYYY-MM-DD format.' },
      { role: "user", content: input.text },
    ],
  }))
  .node("merged", "INTERACTION.OUTPUT", ["owner", "deadline"], (input, outputs) => {
    const { owner } = json(outputs.owner);
    const { deadline } = json(outputs.deadline);
    if (typeof owner !== "string" || !owner.trim() || typeof deadline !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(Date.parse(deadline))
      || new Date(deadline).toISOString().slice(0, 10) !== deadline) throw new Error("Invalid branch result");
    return { deliveryId: input.id, message: { role: "assistant", content: { route: "merged", owner, deadline } } };
  });

export async function runBranchMerge(runtime: Runner, input: Request) {
  validateRequest(input);
  const output = await runtime.run(mergeGraph, input);
  if (output.merged.status !== "accepted") throw new Error(`Delivery was not accepted: ${output.merged.status}`);
  return { content: { route: "merged", owner: String(json(output.owner).owner), deadline: String(json(output.deadline).deadline) },
    samples: [output.owner, output.deadline], receipt: output.merged };
}
if (isMain(import.meta.url)) await cli((runtime, model) => runBranchMerge(runtime, {
  id: "handoff", model, text: "Owner: TEAM-731. Deadline: 2026-12-15.",
}));
