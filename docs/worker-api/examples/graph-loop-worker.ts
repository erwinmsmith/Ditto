import { createDitto, createInteractionWorker, graph, loop } from "@codesoul-co/ditto";

// 1. Graph: typed data flow, independent of tool implementations and SDK connections.
const inspect = graph<{ path: string; callId: string }>("inspect-files")
  .node("read", "INTERACTION.ACT.TOOL", [], ({ path, callId }) => ({
    call: { id: callId, name: "inspect_text", arguments: { path } },
  }))
  .node("observe", "INTERACTION.OBSERVE", ["read"], (_input, { read }) => ({ result: read }))
  .node("deliver", "INTERACTION.OUTPUT", ["observe"], ({ callId }, { observe }) => {
    if (observe.status !== "success") throw new Error("File inspection failed");
    return { deliveryId: `delivery:${callId}`, message: { role: "assistant", content: observe.message.content } };
  });

// 2. Loop: iteration state and stopping policy, outside the Worker.
interface State { paths: readonly string[]; index: number; }
const inspectFiles = loop({
  graph: inspect,
  maxIterations: 2,
  bind: ({ paths, index }: State) => ({ path: paths[index]!, callId: `inspect:${index}` }),
  update: (state: State) => ({ ...state, index: state.index + 1 }),
  done: (state: State) => state.index >= state.paths.length,
});

// 3. Worker: concrete capabilities and output channel, with no separate plugin manager.
const interaction = createInteractionWorker({
  tools: [{
    name: "inspect_text",
    description: "Count characters and lines in a workspace text file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    effects: ["read"], requiresApproval: false,
    validate(args) {
      if (typeof args.path !== "string" || !args.path.trim()) throw new Error("path is required");
    },
    async execute(args, context) {
      const text = await context.services.sandbox.readText(args.path as string);
      return { status: "success", structuredContent: { path: args.path!, characters: text.length, lines: text.split("\n").length } };
    },
  }],
  output: {
    async deliver(input) {
      console.log(JSON.stringify({ deliveryId: input.deliveryId, message: input.message }));
      return { deliveryId: input.deliveryId, status: "accepted" };
    },
  },
});

// Runtime executes the plan; this example performs real file reads, with no model/DB credentials.
const runtime = createDitto({ sandbox: { tools: ["inspect_text"], read: true }, workers: [interaction] });
try {
  await runtime.loop(inspectFiles, { paths: ["README.md", "package.json"], index: 0 });
} finally { await runtime.close(); }
