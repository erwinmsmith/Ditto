import { graph } from "@ditto/core/runtime";
import { identifier, object, toJsonObject } from "../../_shared/tools/order-files.ts";
import { buildSummaryGraph } from "./fan-out-fan-in.ts";
import { runCli, isMain } from "./cli.ts";
import { accepted, modelJson, toolData, validateBatch, validateOptions, type BatchInput, type ExecutionOptions, type Runner } from "./shared.ts";

export interface ExtractTask { id: string; kind: "extract"; sourceId: string; dependsOn: string[] }
export interface SummaryTask { id: string; kind: "summary"; dependsOn: string[] }
export interface OrderPlan { tasks: (ExtractTask | SummaryTask)[] }
export interface PlanningInput extends BatchInput { readonly objective: string }
/** Validate model-proposed work against the application's finite capability and source catalog. */
export function validatePlan(value: unknown, input: BatchInput): OrderPlan {
  const data = object(value);
  if (!Array.isArray(data.tasks) || data.tasks.length !== input.sources.length + 1) throw new Error("Plan must cover every source and one summary");
  const ids = new Set<string>(), used = new Set<string>();
  const tasks: OrderPlan["tasks"] = [];
  for (const item of data.tasks) {
    const task = object(item), id = identifier(task.id);
    if (ids.has(id)) throw new Error("Duplicate plan task ID");
    ids.add(id);
    if (!Array.isArray(task.dependsOn)) throw new Error("Plan dependencies must be an array");
    const dependsOn = task.dependsOn.map(identifier);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error("Duplicate plan dependency");
    if (task.kind === "extract") {
      const sourceId = identifier(task.sourceId);
      if (!input.sources.some(source => source.id === sourceId) || used.has(sourceId)) throw new Error("Unknown or duplicate planned source");
      if (dependsOn.length) throw new Error("Independent source extraction must not depend on another task");
      used.add(sourceId); tasks.push({ id, kind: "extract", sourceId, dependsOn });
    } else if (task.kind === "summary") tasks.push({ id, kind: "summary", dependsOn });
    else throw new Error("Unsupported planned operation");
  }
  const extracts = tasks.filter(task => task.kind === "extract");
  const summaries = tasks.filter(task => task.kind === "summary");
  if (used.size !== input.sources.length || summaries.length !== 1) throw new Error("Incomplete plan");
  if (JSON.stringify([...summaries[0]!.dependsOn].sort()) !== JSON.stringify(extracts.map(task => task.id).sort())) throw new Error("Summary must depend on every extraction and no other task");
  return { tasks };
}
export const planningGraph = graph<PlanningInput>("plan-parallel-orders")
  .node("proposed", "INFER.REASONING.SAMPLE", [], input => ({ model: input.model, messages: [
    { role: "system", content: 'Plan the requested order-processing task using ONLY the supplied source catalog. Each source is independent. Use one extract task per source and one summary task. Return ONLY JSON {"tasks":[{"id":"unique_identifier","kind":"extract","sourceId":"catalog_id","dependsOn":[]},{"id":"unique_identifier","kind":"summary","dependsOn":["all extract task ids"]}]}. IDs contain only letters, digits, underscore or hyphen (at most 64 characters). Identify independent tasks with empty dependencies. The summary must wait for every extraction. Do not invent sources, operations or permissions.' },
    { role: "user", content: JSON.stringify({ objective: input.objective, sources: input.sources.map(source => ({ id: source.id, description: source.description })) }) },
  ] }))
  .node("persisted", "INTERACTION.ACT.TOOL", ["proposed"], (input, { proposed }) => ({ call: {
    id: `${input.id}:plan`, name: "save_parallel_plan", arguments: { batchId: input.id, plan: toJsonObject(validatePlan(modelJson(proposed), input)) },
  } }));

export async function runPlanning(runtime: Runner, input: PlanningInput, options: ExecutionOptions = {}) {
  validateBatch(input); validateOptions(options);
  if (!input.sources.length || !input.objective.trim()) throw new Error("Planning requires an objective and at least one source");
  const planned = await runtime.run(planningGraph, input, options);
  const plan = validatePlan(toolData(planned.persisted), input);
  const branches = plan.tasks.filter(task => task.kind === "extract").map(task => ({ taskId: task.id, sourceId: task.sourceId }));
  const summary = plan.tasks.find(task => task.kind === "summary")!;
  const output = await runtime.run(buildSummaryGraph(branches, summary.id), input, { concurrency: options.concurrency ?? 3, ...(options.signal ? { signal: options.signal } : {}) });
  accepted(output.delivered);
  return { plan, planning: planned, report: toolData(output[`join:${summary.id}`]), receipt: output.delivered, output };
}
if (isMain(import.meta.url)) await runCli((runtime, input, options) => runPlanning(runtime, { ...input,
  objective: "Extract every supplied order independently, then consolidate quantities and revenue into one report.",
}, options));
