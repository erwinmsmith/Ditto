import assert from "node:assert/strict";
import test from "node:test";
import {
  createDitto, defineWorker, createAgentNodes, ProviderRegistry, ToolRegistry, SkillRegistry,
  loadRuntimeConfig, registerMcpTools, Sandbox, type ModelRequest,
} from "../src/index.js";

const selection = { provider: "mock", model: "test-model" };

test("Agent Node runs skills + validated tool calls + model continuation on the same worker", async () => {
  const providers = new ProviderRegistry(); const tools = new ToolRegistry(); const skills = new SkillRegistry();
  const requests: ModelRequest[] = [];
  providers.register("mock", { async generate(request) {
    requests.push(structuredClone({ model: request.model, messages: request.messages }));
    assert.equal(request.model, "test-model");
    return request.messages.at(-1)?.role === "tool" ? { content: "done", toolCalls: [] } : {
      content: "", toolCalls: [{ id: "t1", name: "add", arguments: { a: 2, b: 3 } }],
    };
  } });
  let called = 0;
  tools.register({ name: "add", description: "Add two values", inputSchema: { type: "object" },
    validate: (args) => { if (typeof args.a !== "number" || typeof args.b !== "number") throw new Error("Invalid operands"); },
    execute: async (args, ctx) => {
      assert.equal(ctx.worker.workerId, "one"); called++; return (args.a as number) + (args.b as number);
    },
  });
  skills.register({ name: "brief", instructions: "Be brief." });
  const runtime = createDitto({ providers, sandbox: { tools: ["add"], skills: ["brief"] } });
  runtime.register(defineWorker({ type: "assistant", concurrency: 1,
    nodes: createAgentNodes({ model: selection, tools, skills }),
  }), "one");
  const result = await runtime.invoke("AGENT.RUN", { messages: [{ role: "user", content: "2+3?" }], skills: ["brief"] });
  assert.equal(result.content, "done"); assert.equal(result.turns, 2); assert.equal(called, 1);
  assert.equal(requests[0]!.messages[0]!.content, "Be brief.");
  assert.deepEqual(requests[1]!.messages.at(-1), { role: "tool", toolCallId: "t1", content: "5" });
  await assert.rejects(runtime.invoke("AGENT.TOOL", { name: "add", arguments: { a: "bad" } }), /Invalid operands/);
  assert.equal(called, 1);
  await runtime.close();
});

test("unoffered tools and denied skills cannot run, and the last model turn performs no tool effects", async () => {
  let effects = 0;
  const providers = new ProviderRegistry(); const tools = new ToolRegistry();
  providers.register("mock", { async generate() { return { content: "", toolCalls: [{ id: "t", name: "side_effect", arguments: {} }] }; } });
  tools.register({ name: "side_effect", description: "Effect", inputSchema: { type: "object" }, validate: () => {},
    execute: async () => { effects++; return null; },
  });
  const make = (maxTurns: number, permitted = false) => createDitto({ providers,
    sandbox: { tools: permitted ? ["side_effect"] : [] },
    workers: [defineWorker({ type: "agent", nodes: createAgentNodes({ model: selection, tools, maxTurns }) })],
  });
  const denied = make(2); const limited = make(1, true);
  await assert.rejects(denied.invoke("AGENT.RUN", { messages: [] }), /unavailable/);
  await assert.rejects(denied.invoke("AGENT.TOOL", { name: "side_effect", arguments: {} }), /Permission denied/);
  await assert.rejects(denied.invoke("AGENT.RUN", { messages: [], skills: ["unknown"] }), /Permission denied/);
  await assert.rejects(limited.invoke("AGENT.RUN", { messages: [] }), /turn limit/);
  assert.equal(effects, 0);
  await denied.close(); await limited.close();
});

test("runtime default model and per-worker provider selection are independent of graph contracts", async () => {
  const providers = new ProviderRegistry();
  for (const name of ["a", "b"]) providers.register(name, { async generate(request) { return { content: `${name}:${request.model}`, toolCalls: [] }; } });
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "a", DITTO_MODEL_PROVIDER: "a", DITTO_MODEL: "default" });
  const runtime = createDitto({ config, providers, workers: [
    defineWorker({ type: "default", nodes: createAgentNodes() }),
    defineWorker({ type: "override", nodes: createAgentNodes({ model: { provider: "b", model: "other" } }) }),
  ] });
  assert.equal((await runtime.invoke("AGENT.GENERATE", { messages: [] })).content, "a:default");
  assert.equal((await runtime.invoke("AGENT.GENERATE", { messages: [] })).content, "b:other");
  await runtime.close();
});

test("MCP pagination installs namespaced tools, preserves tool errors, and rolls back failed registration", async () => {
  const tools = new ToolRegistry(); const seen: unknown[] = [];
  const sandbox = new Sandbox(process.cwd(), { mcp: ["files"] });
  const unregister = await registerMcpTools(tools, "files", {
    async listTools(params) { seen.push(params); return params?.cursor ? {
      tools: [{ name: "write", inputSchema: { type: "object" } }],
    } : { tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "2" }; },
    async callTool(params) { return { isError: true, content: [{ type: "text", text: params.name }] }; },
  }, sandbox);
  assert.deepEqual(seen, [{}, { cursor: "2" }]);
  const runtime = createDitto({ sandbox: { tools: ["files__read"], mcp: ["files"] },
    workers: [defineWorker({ type: "agent", nodes: createAgentNodes({ tools }) })] });
  assert.deepEqual(await runtime.invoke("AGENT.TOOL", { name: "files__read", arguments: {} }), {
    isError: true, content: [{ type: "text", text: "read" }],
  });
  unregister(); await assert.rejects(runtime.invoke("AGENT.TOOL", { name: "files__read", arguments: {} }), /Unknown tool/);
  await assert.rejects(registerMcpTools(tools, "files", {
    async listTools() { return { tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "same" }; },
    async callTool() { return {}; },
  }, sandbox), /duplicate|repeated/);
  await assert.rejects(runtime.invoke("AGENT.TOOL", { name: "files__read", arguments: {} }), /Unknown tool/);
  await runtime.close();
});
