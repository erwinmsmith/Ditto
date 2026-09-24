import { graph, type ExecutionGraph } from "@codesoul-co/ditto/runtime";
import { runCli, isMain } from "./cli.ts";
import { sampleInput, saveInput, savedOrder, sourceFor, validateBatch, validateOptions, type BatchInput, type ExecutionOptions, type Runner } from "./shared.ts";

export interface Branch { readonly taskId: string; readonly sourceId: string }
/** Dynamic source IDs require a runtime-keyed output map; Graph still validates every edge. */
export function buildParallelGraph(branches: readonly Branch[], graphId = "parallel-orders") {
  let plan: ExecutionGraph<BatchInput, Record<string, unknown>> = graph<BatchInput>(graphId);
  for (const branch of branches) {
    const read = `read:${branch.taskId}`, sample = `sample:${branch.taskId}`, save = `save:${branch.taskId}`;
    plan = plan
      .node(read, "INTERACTION.ACT.TOOL", [], input => ({ call: {
        id: `${input.id}:${branch.sourceId}:read`, name: "read_order_source", arguments: { sourceId: branch.sourceId, path: sourceFor(input, branch.sourceId).path },
      } }))
      .node(sample, "INFER.REASONING.SAMPLE", [read], (input, output) => sampleInput(input.model, output[read]))
      .node(save, "INTERACTION.ACT.TOOL", [read, sample], (input, output) => saveInput(input.id, branch.sourceId, output[read], output[sample]));
  }
  return plan;
}
export async function runParallel(runtime: Runner, input: BatchInput, options: ExecutionOptions = {}) {
  validateBatch(input); validateOptions(options);
  const branches = input.sources.map(source => ({ taskId: source.id, sourceId: source.id }));
  const output = await runtime.run(buildParallelGraph(branches), input, { concurrency: options.concurrency ?? 2, ...(options.signal ? { signal: options.signal } : {}) });
  const orders = branches.map(branch => savedOrder(output[`save:${branch.taskId}`]));
  return { orders, output };
}
if (isMain(import.meta.url)) await runCli((runtime, input, options) => runParallel(runtime, input, options));
