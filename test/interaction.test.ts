import assert from "node:assert/strict";
import test from "node:test";
import {
  createDitto, defineWorker, createInteractionNodes, ProviderRegistry, ToolRegistry, SkillRegistry,
  loadRuntimeConfig, registerMcpTools, Sandbox, createGenerateNode, graph, loop, type ModelRequest, type ModelMessage,
} from "../src/index.js";

const selection = { provider: "mock", model: "test-model" };

interface AgentState { messages: readonly ModelMessage[]; turns: number }
function agentLoop(maxIterations: number) {
  const step = graph<AgentState>("agent-step")
    .node("response", "REASONING.GENERATE", [], (state) => ({ messages: state.messages }))
    .node("tools", "INTERACTION.TOOL_BATCH", ["response"], (state, { response }) => {
      if (response.toolCalls.length && state.turns + 1 >= maxIterations) throw new Error("Agent turn limit reached");
      return { calls: response.toolCalls };
    });
  return loop({ graph: step, maxIterations, bind: (state: AgentState) => state,
    update: (state, { response, tools }): AgentState => ({ turns: state.turns + 1, messages: [
      ...state.messages, { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      ...tools.map(({ id, result }) => ({ role: "tool" as const, toolCallId: id, content: JSON.stringify(result) })),
    ] }),
    done: (_state, { response }) => response.toolCalls.length === 0,
  });
}

test("Runtime Loop composes skills, model generation and validated tools across Workers", async () => {
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
  runtime.register(defineWorker({ type: "REASONING", nodes: {
    "REASONING.GENERATE": createGenerateNode({ model: selection, tools: (ctx) => tools.list(ctx) }),
  } }));
  runtime.register(defineWorker({ type: "INTERACTION", concurrency: 1,
    nodes: createInteractionNodes({ tools, skills }),
  }), "one");
  const skill = await runtime.invoke("INTERACTION.SKILL", { name: "brief" });
  const result = await runtime.loop(agentLoop(3), { turns: 0, messages: [
    { role: "system", content: skill.instructions }, { role: "user", content: "2+3?" },
  ] });
  assert.equal(result.messages.at(-1)!.content, "done"); assert.equal(result.turns, 2); assert.equal(called, 1);
  assert.equal(requests[0]!.messages[0]!.content, "Be brief.");
  assert.deepEqual(requests[1]!.messages.at(-1), { role: "tool", toolCallId: "t1", content: "5" });
  await assert.rejects(runtime.invoke("INTERACTION.TOOL", { name: "add", arguments: { a: "bad" } }), /Invalid operands/);
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
  const make = (permitted = false) => createDitto({ providers,
    sandbox: { tools: permitted ? ["side_effect"] : [] },
    workers: [defineWorker({ type: "REASONING", nodes: {
      "REASONING.GENERATE": createGenerateNode({ model: selection, tools: (ctx) => tools.list(ctx) }),
    } }), defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools }) })],
  });
  const denied = make(); const limited = make(true);
  await assert.rejects(denied.loop(agentLoop(2), { messages: [], turns: 0 }), /unavailable/);
  await assert.rejects(denied.invoke("INTERACTION.TOOL", { name: "side_effect", arguments: {} }), /Permission denied/);
  await assert.rejects(denied.invoke("INTERACTION.SKILL", { name: "unknown" }), /Permission denied/);
  await assert.rejects(limited.loop(agentLoop(1), { messages: [], turns: 0 }), /turn limit/);
  assert.equal(effects, 0);
  await denied.close(); await limited.close();
});

test("runtime default model and per-worker provider selection are independent of graph contracts", async () => {
  const providers = new ProviderRegistry();
  for (const name of ["a", "b"]) providers.register(name, { async generate(request) { return { content: `${name}:${request.model}`, toolCalls: [] }; } });
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "a", DITTO_MODEL_PROVIDER: "a", DITTO_MODEL: "default" });
  const runtime = createDitto({ config, providers, workers: [
    defineWorker({ type: "default", nodes: { "REASONING.GENERATE": createGenerateNode() } }),
    defineWorker({ type: "override", nodes: { "REASONING.GENERATE": createGenerateNode({ model: { provider: "b", model: "other" } }) } }),
  ] });
  assert.equal((await runtime.invoke("REASONING.GENERATE", { messages: [] })).content, "a:default");
  assert.equal((await runtime.invoke("REASONING.GENERATE", { messages: [] })).content, "b:other");
  await runtime.close();
});

test("tool batches validate identities before effects, preserve order, and stop on failure", async () => {
  const tools = new ToolRegistry();
  const effects: number[] = [];
  tools.register({ name: "effect", description: "Record a value", inputSchema: { type: "object" },
    validate: (args) => { if (typeof args.value !== "number") throw new Error("Invalid value"); },
    execute: async (args) => { effects.push(args.value as number); return args.value!; },
  });
  const runtime = createDitto({ sandbox: { tools: ["effect"] }, workers: [
    defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools }) }),
  ] });
  const call = (id: string, value: number) => ({ id, name: "effect", arguments: { value } });
  try {
    assert.deepEqual(await runtime.invoke("INTERACTION.TOOL_BATCH", { calls: [] }), []);
    for (const calls of [[call("a", 1), call("a", 2)], [call("", 1)],
      [call("a", 1), { ...call("b", 2), name: "unknown" }]]) {
      await assert.rejects(runtime.invoke("INTERACTION.TOOL_BATCH", { calls }), /Invalid or unavailable/);
    }
    assert.deepEqual(effects, []);
    assert.deepEqual(await runtime.invoke("INTERACTION.TOOL_BATCH", { calls: [call("a", 1), call("b", 2)] }), [
      { id: "a", result: 1 }, { id: "b", result: 2 },
    ]);
    await assert.rejects(runtime.invoke("INTERACTION.TOOL_BATCH", { calls: [
      call("a", 3), { id: "b", name: "effect", arguments: {} }, call("c", 4),
    ] }), /Invalid value/);
    assert.deepEqual(effects, [1, 2, 3]);
  } finally { await runtime.close(); }
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
    workers: [defineWorker({ type: "agent", nodes: createInteractionNodes({ tools }) })] });
  assert.deepEqual(await runtime.invoke("INTERACTION.TOOL", { name: "files__read", arguments: {} }), {
    isError: true, content: [{ type: "text", text: "read" }],
  });
  unregister(); await assert.rejects(runtime.invoke("INTERACTION.TOOL", { name: "files__read", arguments: {} }), /Unknown tool/);
  await assert.rejects(registerMcpTools(tools, "files", {
    async listTools() { return { tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "same" }; },
    async callTool() { return {}; },
  }, sandbox), /duplicate|repeated/);
  await assert.rejects(runtime.invoke("INTERACTION.TOOL", { name: "files__read", arguments: {} }), /Unknown tool/);
  await runtime.close();
});
