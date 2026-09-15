import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRegistry, ToolRegistry, createDitto, createInteractionNodes, defineWorker,
  interactionMcpContextUpdate, interactionToolContextUpdate, memorySkillContextUpdate,
  mergeContextUpdate,
} from "../src/index.js";

test("Tool and MCP stay distinct and both cross the typed CONTEXT.UPDATE ingress", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo", inputSchema: {}, validate: () => undefined,
    execute: async (args) => args,
  });
  const mcp = new McpRegistry();
  mcp.register("docs", {
    listTools: async () => ({ tools: [{ name: "lookup", inputSchema: {} }] }),
    callTool: async ({ arguments: arguments_ }) => arguments_,
  });
  const runtime = createDitto({ sandbox: { tools: ["echo"], mcp: ["docs"] }, workers: [
    defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp }) }),
    defineWorker({ type: "CONTEXT", nodes: { "CONTEXT.UPDATE": mergeContextUpdate } }),
  ] });
  const toolResult = await runtime.invoke("INTERACTION.ACT.TOOL", { call: { name: "echo", arguments: { value: 1 } } });
  const mcpResult = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "invoke", server: "docs", call: { name: "lookup", arguments: { q: "ditto" } } });
  const ingress = [
    ...interactionToolContextUpdate.map(toolResult),
    ...interactionMcpContextUpdate.map(mcpResult),
    ...memorySkillContextUpdate.map({ name: "review", instructions: "check boundaries" }),
  ];
  const context = await runtime.invoke("CONTEXT.UPDATE", { context: { items: [] }, ingress });
  assert.deepEqual(context.items.map((item) => item.metadata?.sourceNode), [
    "INTERACTION.ACT.TOOL", "INTERACTION.ACT.MCP", "MEMORY.SKILL",
  ]);
});
