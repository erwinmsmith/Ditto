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
    message: { role: "assistant", content: "past evidence" },
  };
  const runtime = createDitto({ sandbox: { tools: ["echo"], mcp: ["docs"] }, workers: [
    defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp }) }),
    defineWorker({ type: "CONTEXT", nodes: {
      "CONTEXT.UPDATE": mergeContextUpdate,
      "CONTEXT.RAG.RETRIEVE": async ({ corpus }) => Array.isArray(corpus)
        ? corpus.map((item: KnowledgeItem) => ({ item }))
        : [],
      "CONTEXT.RAG.RANK": async ({ candidates }) => candidates,
    } }),
    defineWorker({ type: "MEMORY", nodes: {
      "MEMORY.SKILL": async ({ name, version }) => ({
        name,
        ...(version === undefined ? {} : { version }),
        instructions: "follow the review checklist",
      }),
      "MEMORY.RAG.RETRIEVE": async () => [{ memory }],
      "MEMORY.RAG.RANK": async ({ candidates }) => candidates,
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
  const skill = await runSkillFlow(runtime, { context: mcpResult.context, name: "review" });
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
  });

  assert.equal(tool.output.source, "echo");
  assert.equal(mcpResult.output.operation, "invoke");
  assert.equal(skill.output.name, "review");
  assert.equal(contextRag.output[0]?.item.id, "doc-1");
  assert.equal(memoryRag.output[0]?.memory.id, "memory-1");
  assert.deepEqual(memoryRag.context.items.map((item) => item.metadata?.sourceNode), [
    "INTERACTION.OBSERVE", "INTERACTION.OBSERVE", "MEMORY.SKILL",
    "CONTEXT.RAG.RANK", "MEMORY.RAG.RANK",
  ]);
});
