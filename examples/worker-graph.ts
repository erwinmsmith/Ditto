import { createDitto, extendWorker, type Message } from "@ditto/core";
import type { MemoryItem } from "@ditto/core/worker/memory";

// This fixture demonstrates ownership and dataflow, not a production search engine.
const memory = extendWorker("MEMORY", {
  resources: () => ({ records: [
    { id: "1", message: { role: "user", content: "Ditto scales Worker instances." } },
    { id: "2", message: { role: "user", content: "Graphs refer to semantic Node capabilities." } },
  ] satisfies MemoryItem[] }),
  nodes: {
    RETRIEVE: async ({ query }, ctx) => ctx.resources.records.filter((item) =>
      item.message.content.toLowerCase().includes(String(query.content).toLowerCase())),
  },
});
const context = extendWorker("CONTEXT", {
  nodes: {
    LOAD: async ({ sources }) => ({ items: sources.map((source, i) => ({
      id: String(i), content: "role" in source ? source.content : [{ type: "reference" as const, reference: source }],
    })) }),
  },
});
const reasoning = extendWorker("REASONING", {
  nodes: { INFER: async ({ messages }) => ({
    role: "assistant", content: messages.map((message) => String(message.content)).join("\n"),
  }) },
});
const interaction = extendWorker("INTERACTION", {
  nodes: { OUTPUT: async ({ message }) => message },
});

const ditto = createDitto({ workers: [memory, context, reasoning, interaction] });
const plan = ditto.graph<Message>("worker-owned-capabilities")
  .node("retrieve", "MEMORY.RETRIEVE", [], (query) => ({ query }))
  .node("context", "CONTEXT.LOAD", ["retrieve"], (_query, result) => ({
    sources: result.retrieve.map((item) => item.message),
  }))
  .node("infer", "REASONING.INFER", ["context"], (_query, result) => ({
    messages: result.context.items.map((item) => ({ role: "user", content: item.content })),
  }))
  .node("output", "INTERACTION.OUTPUT", ["infer"], (_query, result) => ({ message: result.infer }));
try {
  const result = await ditto.run(plan, { role: "user", content: "Ditto" });
  console.log(result.output.content);
} finally {
  await ditto.close();
}
