import { pathToFileURL } from "node:url";
import type { ContextItem } from "@codesoul-co/ditto/contracts";
import { createDitto, graph } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInteractionWorker, type InteractionOutputInput } from "@codesoul-co/ditto/worker/interaction";

export interface DependenciesInput {
  readonly items: readonly ContextItem[];
  readonly additions: readonly ContextItem[];
  readonly query: string;
  readonly limit: number;
  readonly deliveryId: string;
}

export const dependenciesInput: DependenciesInput = {
  items: [
    { id: "graph", content: "A Graph declares dependencies between steps." },
    { id: "memory", content: "Memory stores information across tasks." },
  ],
  additions: [{ id: "binding", content: "A bind function maps dependency outputs to the next input." }],
  query: "bind",
  limit: 1,
  deliveryId: "sequence-dependencies",
};

export const dependenciesGraph = graph<DependenciesInput>("sequence-dependencies")
  .node("loaded", "CONTEXT.LOAD", [], input => ({ sources: input.items }))
  .node("updated", "CONTEXT.UPDATE", ["loaded"], (input, { loaded }) => ({
    context: loaded,
    add: input.additions,
  }))
  .node("selected", "CONTEXT.SELECT", ["updated"], (input, { updated }) => ({
    context: updated,
    purpose: "infer",
    query: input.query,
    limit: input.limit,
  }))
  // Transitive dependencies are not visible in bind: request loaded explicitly.
  .node("delivered", "INTERACTION.OUTPUT", ["loaded", "selected"], (input, { loaded, selected }) => ({
    deliveryId: input.deliveryId,
    message: {
      role: "assistant",
      content: {
        originalItemIds: loaded.items.map(item => item.id),
        selectedItemIds: selected.selectedItemIds,
        selectedContent: selected.context.items.map(item =>
          typeof item.content === "string" ? item.content : JSON.stringify(item.content)),
      },
    },
  }));

export async function runDependencies(input: DependenciesInput = dependenciesInput) {
  // This application sink accepts deliveries into a local collection.
  const deliveries: InteractionOutputInput[] = [];
  const runtime = createDitto({ workers: [
    createContextWorker(),
    createInteractionWorker({ output: {
      async deliver(delivery) {
        deliveries.push(delivery);
        return { deliveryId: delivery.deliveryId, status: "accepted" };
      },
    } }),
  ] });
  try {
    const results = await runtime.run(dependenciesGraph, input);
    // A returned receipt is ordinary graph data, not an automatic success check.
    if (results.delivered.status !== "accepted") {
      throw new Error(`Delivery was not accepted: ${results.delivered.status}`);
    }
    return { ...results, deliveries };
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDependencies();
  console.log(JSON.stringify({
    message: result.deliveries[0]?.message.content,
    receipt: result.delivered,
  }, null, 2));
}
