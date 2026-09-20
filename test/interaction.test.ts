import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRegistry, ToolRegistry, createDitto, createInteractionNodes, defineWorker,
  mergeContextUpdate, runMcpFlow, runRagFlow, runSkillFlow, runToolCallFlow,
  type KnowledgeItem, type MemoryItem,
} from "../src/index.js";

test("the four Runtime flows execute source Nodes and update Context", async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo", inputSchema: {}, validate: () => undefined,
    execute: async (args) => ({ status: "success", content: args }),
  });
  const mcp = new McpRegistry();
  mcp.register("docs", {
    listTools: async () => ({ tools: [{ name: "lookup", inputSchema: {} }] }),
    callTool: async ({ arguments: arguments_ }) => ({ content: arguments_ }),
  });
  const memory: MemoryItem = {
    id: "memory-1",
    key: "known-fix",
    content: "past evidence",
  };
  const runtime = createDitto({ sandbox: { tools: ["echo"], mcp: ["docs"] }, workers: [
    defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp }) }),
    defineWorker({ type: "CONTEXT", nodes: {
      "CONTEXT.UPDATE": mergeContextUpdate,
      "CONTEXT.SKILL": async ({ context, skill }, ctx) => mergeContextUpdate({ context, ingress: [{
        id: skill.name, sourceNode: "CONTEXT.SKILL", content: skill.instructions,
      }] }, ctx),
      "CONTEXT.RAG.RETRIEVE": async ({ corpus }) => Array.isArray(corpus)
        ? corpus.map((item: KnowledgeItem) => ({ item }))
        : [],
      "CONTEXT.RAG.RANK": async ({ candidates }) => candidates,
    } }),
    defineWorker({ type: "MEMORY", nodes: {
      "MEMORY.SEARCH": async () => ({ executionId: "test", node: "MEMORY.SEARCH", status: "success", output: [{ memory }] }),
    } }),
  ] });

  const tool = await runToolCallFlow(runtime, {
    context: { items: [] },
    call: { id: "tool-1", name: "echo", arguments: { value: 1 } },
  });
  const mcpResult = await runMcpFlow(runtime, {
    context: tool.context,
    request: { operation: "invoke", server: "docs", call: { id: "mcp-1", name: "lookup", arguments: { q: "ditto" } } },
  });
  const skill = await runSkillFlow(runtime, { context: mcpResult.context, skill: { name: "review", instructions: "review checklist" } });
  const contextRag = await runRagFlow(runtime, {
    scope: "context",
    context: skill.context,
    query: "current task",
    corpus: [{ id: "doc-1", content: "current evidence" }],
  });
  const memoryRag = await runRagFlow(runtime, {
    scope: "memory",
    context: contextRag.context,
    query: "past task",
    mapMemory: ({ memory }) => ({ id: memory.id, sourceNode: "MEMORY.SEARCH", content: String(memory.content) }),
  });

  assert.equal(tool.output.source, "echo");
  assert.equal(mcpResult.output.operation, "invoke");
  assert.equal(skill.output.name, "review");
  assert.equal(contextRag.output[0]?.item.id, "doc-1");
  assert.equal(memoryRag.output[0]?.memory.id, "memory-1");
  assert.deepEqual(memoryRag.context.items.map((item) => item.metadata?.sourceNode), [
    "INTERACTION.OBSERVE", "INTERACTION.OBSERVE", "CONTEXT.SKILL",
    "CONTEXT.RAG.RANK", "MEMORY.SEARCH",
  ]);
});
