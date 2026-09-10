import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createDitto, defineWorker, createHttpTransport, createWorkerHttpHandler, createAgentNodes, ProviderRegistry, loadRuntimeConfig } from "../src/index.js";

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


test("remote Agent entry uses server-owned model configuration and runs private Nodes", async () => {
  const providers = new ProviderRegistry();
  providers.register("server-model", { async generate(request) {
    assert.equal(request.model, "owned-by-server");
    return { content: "remote-agent", toolCalls: [] };
  } });
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "server_model", DITTO_PROVIDER_SERVER_MODEL_API_KEY: "private-fixture" });
  const remote = createDitto({ hostId: "agent-server", config, providers });
  const handle = remote.register(defineWorker({ type: "assistant", expose: ["AGENT.RUN"],
    nodes: createAgentNodes({ model: { provider: "server-model", model: "owned-by-server" } }),
  }));
  const server = createServer(createWorkerHttpHandler(remote, { token: "fixture-token" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const transport = createHttpTransport({ id: "agent-http", url: `http://127.0.0.1:${address.port}/ditto/invoke`, token: "fixture-token" });
  const local = createDitto({ transports: [{ id: transport.id, invoke: (envelope) => {
    assert.equal(JSON.stringify(envelope).includes("private-fixture"), false);
    return transport.invoke(envelope);
  } }] });
  local.registerRemote({ address: handle.address, capabilities: ["AGENT.RUN"], transportId: transport.id });
  try {
    const result = await local.invoke("AGENT.RUN", { messages: [{ role: "user", content: "hello" }] });
    assert.equal(result.content, "remote-agent");
    assert.equal(result.turns, 1);
    await assert.rejects(remote.receive({ id: "private-node", target: handle.address, node: "AGENT.GENERATE",
      payload: { kind: "inline", value: { messages: [] } } }), /mismatched/);
  } finally {
    await local.close(); await remote.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
