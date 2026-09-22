import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRegistry, ToolRegistry, createContextWorker, createDitto, createInteractionNodes,
  defineWorker, runMcpFlow, runRagFlow, runSkillFlow, runToolCallFlow,
} from "../src/index.js";

test("the four Runtime flows compose Context without adding semantic Nodes", async () => {
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
  const runtime = createDitto({ sandbox: { tools: ["echo"], mcp: ["docs"] }, workers: [
    defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp }) }),
    createContextWorker({ services: { ragStrategy: { select: async () => [
      { id: "doc-1", content: "current evidence", source: { uri: "urn:docs" } },
    ] } } }),
  ] });

  try {
    const tool = await runToolCallFlow(runtime, {
      context: { items: [] },
      call: { id: "tool-1", name: "echo", arguments: { value: 1 } },
    });
    const mcpResult = await runMcpFlow(runtime, {
      context: tool.context,
      request: { operation: "invoke", server: "docs", call: { id: "mcp-1", name: "lookup", arguments: { q: "ditto" } } },
    });
    const skill = await runSkillFlow(runtime, {
      context: mcpResult.context,
      sources: [{ id: "skill-review", content: "review checklist", metadata: { resourceType: "skill", protected: true } }],
    });
    const rag = await runRagFlow(runtime, {
      context: skill.context,
      query: "current task",
      corpus: { uri: "urn:docs" },
    });

    assert.equal(tool.output.source, "echo");
    assert.equal(mcpResult.output.operation, "invoke");
    assert.equal(skill.output.items.at(-1)?.id, "skill-review");
    assert.deepEqual(skill.context.items.slice(0, 2).map(item => item.metadata?.sourceNode), [
      "INTERACTION.OBSERVE", "INTERACTION.OBSERVE",
    ]);
    assert.equal(rag.output.context.items[0]?.id, "doc-1");
    assert.deepEqual(rag.output.selectedItemIds, ["doc-1"]);
    assert.equal(rag.context, rag.output.context);
  } finally { await runtime.close(); }
});
