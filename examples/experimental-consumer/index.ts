import {
  createDitto, defineNode, defineWorker, graph,
  type Message, type NodeContract,
} from "@ditto/core";

// Experiment-owned semantics extend the map, without changing built-in inputs.
declare module "@ditto/core/contracts" {
  interface NodeContractMap {
    "SEARCH.QUERY": NodeContract<{ query: string }, readonly { title: string }[]>;
  }
}

const memory = defineWorker({
  type: "MEMORY",
  resources: () => ({ rows: [{ id: "m1", message: { role: "user", content: "Hello Ditto" } as Message }] }),
  nodes: {
    "MEMORY.RETRIEVE": async (_input, ctx) => ctx.resources.rows,
  },
});

const reasoning = defineWorker({
  type: "REASONING",
  nodes: {
    // A fixture implementation, replaceable by an experiment's chosen model.
    "REASONING.INFER": defineNode("REASONING.INFER", async (input) => ({
      role: "assistant", content: input.messages.map((item) => JSON.stringify(item.content)).join("\n"),
    })),
  },
});

const search = defineWorker({
  type: "SEARCH",
  nodes: {
    "SEARCH.QUERY": async (input) => [{ title: input.query }],
  },
});

const agent = graph<Message>("memory-then-infer")
  .node("retrieve", "MEMORY.RETRIEVE", [], (input) => ({ query: input }))
  .node("infer", "REASONING.INFER", ["retrieve"], (_input, outputs) => ({
    messages: outputs.retrieve.map((item) => item.message),
  }));

const ditto = createDitto({ workers: [memory, reasoning, search] });
// A second registration is a new Worker instance. Graph and Contract stay fixed.
const replica = ditto.register(reasoning);
console.log((await ditto.run(agent, { role: "user", content: "Recall" })).infer);
console.log(await ditto.invoke("SEARCH.QUERY", { query: "A custom semantic Node" }));
replica.unregister();
