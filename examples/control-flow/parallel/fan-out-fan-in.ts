import { buildParallelGraph, type Branch } from "./concurrency-limit.ts";
import { runCli, isMain } from "./cli.ts";
import { accepted, deliveryInput, savedOrder, toolData, validateBatch, validateOptions, type BatchInput, type ExecutionOptions, type Runner } from "./shared.ts";

export function buildSummaryGraph(branches: readonly Branch[], joinId = "summary") {
  const dependencies = branches.map(branch => `save:${branch.taskId}`);
  return buildParallelGraph(branches, "parallel-summary")
    .node(`join:${joinId}`, "INTERACTION.ACT.TOOL", dependencies, (input, outputs) => {
      for (const id of dependencies) savedOrder(outputs[id]);
      return { call: { id: `${input.id}:report`, name: "build_order_report", arguments: {
        batchId: input.id, successIds: branches.map(branch => branch.sourceId), failures: [],
      } } };
    })
    .node("delivered", "INTERACTION.OUTPUT", [`join:${joinId}`], (input, outputs) => deliveryInput(input.id, outputs[`join:${joinId}`]));
}
export async function runSummary(runtime: Runner, input: BatchInput, options: ExecutionOptions = {}) {
  validateBatch(input); validateOptions(options);
  const branches = input.sources.map(source => ({ taskId: source.id, sourceId: source.id }));
  const output = await runtime.run(buildSummaryGraph(branches), input, { concurrency: options.concurrency ?? 3, ...(options.signal ? { signal: options.signal } : {}) });
  accepted(output.delivered);
  return { report: toolData(output["join:summary"]), receipt: output.delivered, output };
}
if (isMain(import.meta.url)) await runCli((runtime, input, options) => runSummary(runtime, input, options));
