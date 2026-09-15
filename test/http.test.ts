import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createDitto, defineWorker, createHttpTransport, createWorkerHttpHandler, createGenerateNode, createInteractionNodes, ProviderRegistry, loadRuntimeConfig, graph, loop, type ModelMessage } from "../src/index.js";

test("real HTTP transports run remote workers and reject auth, malformed envelopes and oversized requests", async () => {
  let executions = 0;
  const remote = createDitto({ hostId: "server", processId: "p" });
  const handle = remote.register(defineWorker({ type: "assistant", nodes: {
    "REASONING.INFER": async (input) => { executions++; return input.messages[0]!; },
  } }), "remote");
  const server = createServer(createWorkerHttpHandler(remote, { token: "test-token", maxBodyBytes: 1024 }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/ditto/invoke`;
  const transport = createHttpTransport({ id: "http", url, token: "test-token" });
  const local = createDitto({ transports: [transport] });
  local.registerRemote({ address: handle.address, capabilities: ["REASONING.INFER"], transportId: "http" });
  try {
    assert.deepEqual(await local.invoke("REASONING.INFER", { messages: [{ role: "user", content: "wire" }] }), { role: "user", content: "wire" });
    assert.equal(executions, 1);
    const wrong = await fetch(url, { method: "POST", body: "{}" }); assert.equal(wrong.status, 401);
    const headers = { authorization: "Bearer test-token", "x-ditto-protocol": "1" };
    const bad = await fetch(url, { method: "POST", headers, body: JSON.stringify({ target: handle.address }) }); assert.equal(bad.status, 400);
    const large = await fetch(url, { method: "POST", headers, body: "x".repeat(2048) }); assert.equal(large.status, 413);
    const forged = await fetch(url, { method: "POST", headers, body: JSON.stringify({ id: "i", target: { ...handle.address, processId: "wrong" },
      node: "REASONING.INFER", payload: { kind: "inline", value: { messages: [] } } }) });
    assert.equal(forged.status, 500); assert.equal(executions, 1);
  } finally {
    await local.close(); await remote.close();
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});


test("Runtime Loop executes a remote Graph with server-owned model configuration", async () => {
  const providers = new ProviderRegistry();
  providers.register("server-model", { async generate(request) {
    assert.equal(request.model, "owned-by-server");
    return { content: "remote-agent", toolCalls: [] };
  } });
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "server_model", DITTO_PROVIDER_SERVER_MODEL_API_KEY: "private-fixture" });
  const remote = createDitto({ hostId: "agent-server", config, providers });
  const handle = remote.register(defineWorker({ type: "assistant", expose: ["REASONING.GENERATE"],
    nodes: { ...createInteractionNodes(),
      "REASONING.GENERATE": createGenerateNode({ model: { provider: "server-model", model: "owned-by-server" } }),
    },
  }));
  const server = createServer(createWorkerHttpHandler(remote, { token: "fixture-token" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const transport = createHttpTransport({ id: "agent-http", url: `http://127.0.0.1:${address.port}/ditto/invoke`, token: "fixture-token" });
  const local = createDitto({ transports: [{ id: transport.id, invoke: (envelope) => {
    assert.equal(JSON.stringify(envelope).includes("private-fixture"), false);
    return transport.invoke(envelope);
  } }] });
  local.registerRemote({ address: handle.address, capabilities: ["REASONING.GENERATE"], transportId: transport.id });
  try {
    const step = graph<number>("remote-step").node("response", "REASONING.GENERATE", [], (turn) => ({
      messages: [{ role: "user", content: String(turn) }] satisfies ModelMessage[],
    }));
    const result = await local.loop(loop({ graph: step, bind: (state: number) => state,
      update: (state, { response }) => { assert.equal(response.content, "remote-agent"); return state + 1; },
      done: (state) => state === 2,
    }), 0);
    assert.equal(result, 2);
    await assert.rejects(remote.receive({ id: "private-node", target: handle.address, node: "INTERACTION.SKILL",
      payload: { kind: "inline", value: { name: "private" } } }), /mismatched/);
  } finally {
    await local.close(); await remote.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
