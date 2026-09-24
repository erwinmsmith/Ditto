import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDitto, graph, graphStep, loop, loadRuntimeConfig, type GraphPlan } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";

// A trusted host chooses this catalog. User input never becomes a file path.
const catalog: Readonly<Record<string, string>> = { review: "skills/review/SKILL.md" };
export const loadSkill: RegisteredTool = {
  name: "load_skill", description: "Load an allowed application skill",
  inputSchema: { type: "object", properties: { skill: { type: "string", enum: ["review"] } }, required: ["skill"] },
  validate(args) { if (typeof args.skill !== "string" || !Object.hasOwn(catalog, args.skill)) throw new TypeError("Unknown skill"); },
  async execute(args, ctx) {
    const skill = String(args.skill);
    ctx.services.sandbox.assert("skills", skill);
    const content = await ctx.services.sandbox.readText(catalog[skill]!, ctx.signal);
    if (Buffer.byteLength(content) > 16_384) throw new Error("Skill content is too large");
    return { status: "success", content };
  },
};
const load = graph<string>("skill-load")
  .node("skill", "INTERACTION.ACT.TOOL", [], skill => ({ call: { id: "load-skill", name: "load_skill", arguments: { skill } } }));
const assemble = graph<{ instructions: string; question: string }>("skill-context")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ sources: [
    { id: "skill:review", content: input.instructions, metadata: { role: "system", protected: true } },
    { role: "user", content: input.question },
  ] }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({ context: loaded, purpose: "infer" }));
const plan = loop({
  id: "skill-preparation", maxIterations: 2,
  *plan(question: string): GraphPlan<unknown> {
    const { skill } = yield* graphStep(load, "review");
    if (skill.status !== "success" || typeof skill.content !== "string") throw new Error("Skill could not be loaded");
    return yield* graphStep(assemble, { instructions: skill.content, question });
  },
});
export async function runSkills(question = "Review my technical answer") {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)));
  const runtime = createDitto({ config: loadRuntimeConfig({ DITTO_RUNTIME_WORKSPACE: workspace }),
    sandbox: { read: true, tools: ["load_skill"], skills: ["review"] },
    workers: [createContextWorker(), createInteractionWorker({ tools: [loadSkill] })] });
  try { return await runtime.loop(plan, question); }
  finally { await runtime.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runSkills(process.argv[2]), null, 2));
