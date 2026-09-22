import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRegistry, ToolRegistry, createContextWorker, createDitto, createInteractionWorker,
  runMcpFlow, runRagFlow, runSkillFlow, runToolCallFlow, type ExternalResultStatus,
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
    createInteractionWorker({ tools, mcp }),
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
    assert.deepEqual(tool.context.items[0]?.metadata, {
      callId: "tool-1", source: "echo", status: "success", messageRole: "tool", messageName: "echo",
      sourceNode: "INTERACTION.OBSERVE",
    });
    assert.equal(mcpResult.context.items[1]?.metadata?.callId, "mcp-1");
    assert.equal(mcpResult.context.items[1]?.metadata?.source, "docs:lookup");
    assert.equal(rag.output.context.items[0]?.id, "doc-1");
    assert.deepEqual(rag.output.selectedItemIds, ["doc-1"]);
    assert.equal(rag.context, rag.output.context);
  } finally { await runtime.close(); }
});

test("explicit Interaction flows record business and terminal outcomes in Context", async () => {
  const statuses: Exclude<ExternalResultStatus, "success">[] = ["failed", "cancelled", "timeout", "unknown"];
  const tools = new ToolRegistry();
  tools.register({
    name: "status", inputSchema: {},
    validate(args) {
      if (typeof args.status !== "string" || !statuses.includes(args.status as Exclude<ExternalResultStatus, "success">)) {
        throw new Error("Invalid status");
      }
    },
    async execute(args) {
      const status = args.status as Exclude<ExternalResultStatus, "success">;
      return { status, error: { code: status.toUpperCase(), message: `Tool ${status}` } };
    },
  });
  const runtime = createDitto({ sandbox: { tools: ["status"] }, workers: [
    createInteractionWorker({ tools }), createContextWorker(),
  ] });
  try {
    for (const status of statuses) {
      const result = await runToolCallFlow(runtime, {
        context: { items: [] }, call: { id: `call-${status}`, name: "status", arguments: { status } },
      });
      assert.equal(result.observation.status, status);
      assert.equal(result.context.items[0]?.metadata?.sourceNode, "INTERACTION.OBSERVE");
      assert.equal(result.context.items[0]?.metadata?.status, status);
      assert.equal(result.context.items[0]?.metadata?.errorCode, status.toUpperCase());
    }
  } finally { await runtime.close(); }
});

test("Interaction infrastructure and Context failures never retry external work", async () => {
  let calls = 0;
  const tools = new ToolRegistry();
  tools.register({ name: "once", inputSchema: {}, validate: () => undefined, async execute() {
    calls++; return { status: "success", content: "done" };
  } });
  const denied = createDitto({ workers: [createInteractionWorker({ tools }), createContextWorker()] });
  try {
    await assert.rejects(runToolCallFlow(denied, {
      context: { items: [] }, call: { id: "denied", name: "once", arguments: {} },
    }), /Permission denied/);
    assert.equal(calls, 0);
  } finally { await denied.close(); }

  const full = { items: [{ id: "existing", content: "keep" }] } as const;
  const limited = createDitto({ sandbox: { tools: ["once"] }, workers: [
    createInteractionWorker({ tools }), createContextWorker({ policy: { maxItems: 1 } }),
  ] });
  try {
    await assert.rejects(runToolCallFlow(limited, {
      context: full, call: { id: "one-call", name: "once", arguments: {} },
    }), /Context contains 2 items/);
    assert.equal(calls, 1);
    assert.deepEqual(full, { items: [{ id: "existing", content: "keep" }] });
  } finally { await limited.close(); }
});
