import { pathToFileURL } from "node:url";
import type { ContextItem } from "@ditto/core/contracts";
import { createDitto, graph } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";

export interface PipelineInput {
  readonly items: readonly ContextItem[];
  readonly query: string;
  readonly limit: number;
}

export const pipelineInput: PipelineInput = {
  items: [
    { id: "graph", content: "A Graph declares dependencies between steps." },
    { id: "memory", content: "Memory stores information across tasks." },
  ],
  query: "graph",
  limit: 1,
};

// The dependency, rather than declaration order, makes SELECT wait for LOAD.
export const pipelineGraph = graph<PipelineInput>("sequence-pipeline")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ sources: input.items }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (input, { loaded }) => ({
    context: loaded,
    purpose: "infer",
    query: input.query,
    limit: input.limit,
  }));

export async function runPipeline(input: PipelineInput = pipelineInput) {
  const runtime = createDitto({ workers: [createContextWorker()] });
  try {
    return await runtime.run(pipelineGraph, input);
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPipeline();
  console.log(JSON.stringify({
    loadedItemIds: result.loaded.items.map(item => item.id),
    selectedItemIds: result.selected.selectedItemIds,
  }, null, 2));
}
