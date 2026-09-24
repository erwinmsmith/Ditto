import { createDitto, createInteractionWorker, createRuntimeServices, graph, loadRuntimeConfigFile, loop } from "@codesoul-co/ditto";

// Graphs describe dependencies and data. Worker placement is supplied at execution.
interface Input { value: string; iteration: number }
const makeGraph = (id: string, tool: string) => graph<Input>(id)
  .node("act", "INTERACTION.ACT.TOOL", [], input => ({
    call: { id: `${id}:${input.iteration}`, name: tool, arguments: { value: input.value } },
  }))
  .node("observe", "INTERACTION.OBSERVE", ["act"], (_input, { act }) => {
    if (act.status !== "success") throw new Error(act.error?.message ?? "Tool failed");
    return { result: act };
  });
const read = makeGraph("read", "read_text");
const count = makeGraph("count", "count_text");
const config = loadRuntimeConfigFile("ditto.yaml", {});
const runtime = createDitto({ config });
const reader = runtime.register(createInteractionWorker({ tools: [{
  name: "read_text", inputSchema: { type: "object" }, effects: ["read"], requiresApproval: false,
  validate(args) { if (typeof args.value !== "string") throw new Error("value must be a path"); },
  async execute(args, ctx) {
    return { status: "success", content: await ctx.services.sandbox.readText(args.value as string) };
  },
}] }), { id: "reader", services: createRuntimeServices({ config, sandbox: { tools: ["read_text"], read: true } }) });
const counter = runtime.register(createInteractionWorker({ tools: [{
  name: "count_text", inputSchema: { type: "object" }, effects: [], requiresApproval: false,
  validate(args) { if (typeof args.value !== "string") throw new Error("value must be text"); },
  async execute(args, ctx) {
    const content = String((args.value as string).length);
    await ctx.emit({ type: "counted", payload: { worker: ctx.worker.workerId, characters: Number(content) } });
    return { status: "success", content };
  },
}] }), { id: "counter", services: createRuntimeServices({ config, sandbox: { tools: ["count_text"] } }) });
runtime.subscribe("counted", event => { console.log("event", event.payload); });

interface State { value: string; iteration: number }
const workflow = loop({
  // read once, then run the same count graph twice.
  graph: (state: State) => state.iteration === 0 ? read : count,
  maxIterations: 3,
  bind: (state: State) => state,
  update: (state: State, output) => ({ value: String(output.observe.message.content), iteration: state.iteration + 1 }),
  done: (state: State) => state.iteration === 3,
});
try {
  console.log("result", await runtime.loop(workflow, { value: "README.md", iteration: 0 }, {
    concurrency: 1,
    workers: { read: { act: reader.address.workerId, observe: reader.address.workerId },
      count: { act: counter.address.workerId, observe: counter.address.workerId } },
  }));
  const failures = await runtime.drainEvents();
  if (failures.length) throw new AggregateError(failures.map(f => f.error), "Event consumer failed");
} finally { await runtime.close(); }
