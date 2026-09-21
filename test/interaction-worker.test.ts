import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, createInteractionWorker, graph, loop, McpRegistry, ToolRegistry } from "../src/index.js";

test("Interaction factory runs a Graph and Loop with inline tools, MCP and output", async () => {
  const deliveries: string[] = [];
  const worker = createInteractionWorker({
    concurrency: 2,
    tools: [{
      name: "echo", inputSchema: {},
      validate(args) { assert.equal(typeof args.value, "number"); },
      async execute(args) { return { status: "success", structuredContent: args }; },
    }],
    mcp: { docs: {
      async listTools() { return { tools: [{ name: "lookup", inputSchema: {} }] }; },
      async callTool({ arguments: args }) { return { structuredContent: args }; },
    } },
    output: { async deliver(input) {
      deliveries.push(input.deliveryId);
      assert.equal(input.message.role, "assistant");
      return { deliveryId: input.deliveryId, status: "accepted" };
    } },
  });
  assert.equal(worker.concurrency, 2);
  const plan = graph<number>("interaction")
    .node("tool", "INTERACTION.ACT.TOOL", [], value => ({ call: { id: `call-${value}`, name: "echo", arguments: { value } } }))
    .node("observe", "INTERACTION.OBSERVE", ["tool"], (_value, { tool }) => ({ result: tool }))
    .node("output", "INTERACTION.OUTPUT", ["observe"], (value, { observe }) => {
      assert.equal(observe.callId, `call-${value}`);
      assert.deepEqual(observe.structuredContent, { value });
      return { deliveryId: `delivery-${value}`, message: { role: "assistant", content: observe.message.content } };
    });
  const runtime = createDitto({ sandbox: { tools: ["echo"], mcp: ["docs"] }, workers: [worker] });
  try {
    const final = await runtime.loop(loop({ graph: plan, maxIterations: 2,
      bind: (state: number) => state, update: state => state + 1, done: state => state === 2,
    }), 0);
    assert.equal(final, 2);
    assert.deepEqual(deliveries, ["delivery-0", "delivery-1"]);
    const discovered = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover" });
    assert.deepEqual(discovered, { operation: "discover", capabilities: [{ server: "docs", name: "lookup", inputSchema: {} }] });
    const invoked = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "invoke", server: "docs", call: { id: "mcp-1", name: "lookup", arguments: { query: "x" } } });
    assert.deepEqual(invoked, { operation: "invoke", result: { callId: "mcp-1", source: "docs:lookup", status: "success", structuredContent: { query: "x" } } });
  } finally { await runtime.close(); }
});

test("Interaction factory preserves dynamic registries and optional capability boundaries", async () => {
  assert.deepEqual(createInteractionWorker().capabilities, ["INTERACTION.ACT.TOOL", "INTERACTION.OBSERVE"]);
  const tools = new ToolRegistry();
  const mcp = new McpRegistry({ maxDiscoveryPages: 1 });
  const runtime = createDitto({ sandbox: { tools: ["late"], mcp: ["late"] }, workers: [createInteractionWorker({ tools, mcp })] });
  try {
    const removeTool = tools.register({ name: "late", inputSchema: {}, validate() {}, async execute() { return { status: "success", content: "ready" }; } });
    const removeMcp = mcp.register("late", { async listTools() { return { tools: [], nextCursor: "next" }; }, async callTool() { return { content: "ready" }; } });
    const toolCall = { call: { id: "late-1", name: "late", arguments: {} } };
    assert.equal((await runtime.invoke("INTERACTION.ACT.TOOL", toolCall)).content, "ready");
    await assert.rejects(runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "late" }), /page limit/);
    removeTool(); removeMcp();
    await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", toolCall), /Unknown tool/);
    await assert.rejects(runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "late" }), /Unknown MCP server/);
    await assert.rejects(runtime.invoke("INTERACTION.OUTPUT", { deliveryId: "absent", message: { role: "assistant", content: "done" } }));
  } finally { await runtime.close(); }
});
