import assert from "node:assert/strict";
import test from "node:test";
import {
  createDitto, defineNode, defineWorker, graph, InMemoryArtifactStore,
  LocalEventFabric, NoWorkerAvailableError, PayloadCodec,
  type InvocationEnvelope, type InvokeTransport, type Message,
} from "../src/index.js";

const message: Message = { role: "user", content: "hello" };
const infer = (label: string) => defineWorker({
  type: "REASONING",
  nodes: { "REASONING.INFER": async () => ({ role: "assistant", content: label }) },
});

test("Worker context invokes another capability with isolated resources and config", async () => {
  const ditto = createDitto();
  ditto.register(defineWorker({
    type: "MEMORY",
    resources: () => ({ rows: [{ id: "m1", message }] }),
    nodes: { "MEMORY.RETRIEVE": async (_input, ctx) => ctx.resources.rows },
  }));
  ditto.register(defineWorker({
    type: "REASONING",
    resources: () => ({ prefix: "resource" }),
    config: { suffix: "config" },
    nodes: {
      "REASONING.INFER": async (input, ctx) => {
        assert.deepEqual(Object.keys(input), ["messages"]);
        const memories = await ctx.invoke("MEMORY.RETRIEVE", { query: input.messages[0]! });
        await ctx.emit({ type: "inferred", payload: memories });
        return { role: "assistant", content: `${ctx.resources.prefix}:${memories[0]!.id}:${ctx.config.suffix}` };
      },
    },
  }));
  let seen = 0;
  ditto.subscribe("inferred", () => { seen++; });
  assert.equal((await ditto.invoke("REASONING.INFER", { messages: [message] })).content, "resource:m1:config");
  assert.deepEqual(await ditto.drainEvents(), []);
  assert.equal(seen, 1);
});

test("partial capabilities, replica rotation, availability and removal", async () => {
  const ditto = createDitto();
  ditto.register(defineWorker({ type: "REASONING", nodes: {
    "REASONING.REFLECT": async (input) => input.message,
  } }));
  const a = ditto.register(infer("a"), "a");
  const b = ditto.register(infer("b"), "b");
  for (const label of ["a", "b", "a", "b"]) {
    assert.equal((await ditto.invoke("REASONING.INFER", { messages: [] })).content, label);
  }
  a.setAvailable(false);
  assert.equal((await ditto.invoke("REASONING.INFER", { messages: [] })).content, "b");
  assert.equal(b.unregister(), true);
  assert.equal(b.unregister(), false);
  await assert.rejects(ditto.invoke("REASONING.INFER", { messages: [] }), NoWorkerAvailableError);
  a.setAvailable(true);
  assert.equal((await ditto.invoke("REASONING.INFER", { messages: [] })).content, "a");
  assert.equal(await ditto.invoke("REASONING.REFLECT", { message }), message);
});

test("each registration creates resources once; stale handles cannot remove replacements", async () => {
  let created = 0;
  const worker = defineWorker({
    type: "REASONING",
    resources: () => ({ replica: ++created, calls: 0 }),
    nodes: { "REASONING.INFER": async (_input, ctx) => ({
      role: "assistant", content: `${ctx.resources.replica}:${++ctx.resources.calls}`,
    }) },
  });
  const ditto = createDitto();
  const old = ditto.register(worker, "one");
  assert.throws(() => ditto.register(worker, "one"), /Duplicate/);
  assert.equal(created, 1);
  ditto.register(worker, "two");
  for (const value of ["1:1", "2:1", "1:2", "2:2"]) {
    assert.equal((await ditto.invoke("REASONING.INFER", { messages: [] })).content, value);
  }
  old.unregister();
  ditto.register(worker, "one");
  assert.equal(old.unregister(), false);
  assert.equal(ditto.workers().length, 2);
});

test("direct path preserves identity without encoding even when artifact threshold is zero", async () => {
  const artifacts = new InMemoryArtifactStore();
  artifacts.put = async () => { throw new Error("Direct path must not store payloads"); };
  const input = { messages: [message] };
  const ditto = createDitto({ artifacts, inlineLimitBytes: 0, workers: [defineWorker({
    type: "REASONING", nodes: {
      "REASONING.INFER": defineNode("REASONING", "REASONING.INFER", async (received) => {
        assert.equal(received, input);
        return received.messages[0]!;
      }),
    },
  })] });
  assert.equal(await ditto.invoke("REASONING.INFER", input), message);
});

test("emit accepts without waiting, fans out, and surfaces isolated consumer failures", async () => {
  const ditto = createDitto();
  const gate = Promise.withResolvers<void>();
  let completed = false;
  const remove = ditto.subscribe("changed", async () => { await gate.promise; completed = true; });
  ditto.subscribe("changed", () => { throw new Error("consumer failed"); });
  await ditto.emit({ type: "changed", payload: { id: 1 } });
  assert.equal(completed, false);
  gate.resolve();
  const failures = await ditto.drainEvents();
  assert.equal(completed, true);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]!.error), /consumer failed/);
  assert.equal(remove(), true);
  assert.equal(remove(), false);
  await ditto.emit({ type: "no-consumers", payload: null });
  assert.deepEqual(await ditto.drainEvents(), []);
});

test("event fabric can be shared or replaced independently of invoke transport", async () => {
  const events = new LocalEventFabric();
  const producer = createDitto({ events });
  const consumer = createDitto({ events });
  let seen: unknown;
  consumer.subscribe("observation", (event) => { seen = event.payload; });
  await producer.emit({ type: "observation", payload: message });
  await events.drain();
  assert.equal(seen, message);
});

test("a stale event unsubscribe cannot remove a newly registered subscriber", async () => {
  const events = new LocalEventFabric();
  const old = events.subscribe("update", () => {});
  assert.equal(old(), true);
  let received = 0;
  events.subscribe("update", () => { received++; });
  assert.equal(old(), false);
  await events.emit({ type: "update", payload: null });
  await events.drain();
  assert.equal(received, 1);
});

test("one Graph moves from direct to serialized transport with unchanged bindings and contract", async () => {
  const plan = graph<Message>("agent")
    .node("think", "REASONING.INFER", [], (input) => ({ messages: [input] }))
    .node("output", "INTERACTION.OUTPUT", ["think"], (_input, outputs) => ({ message: outputs.think }));
  const remote = createDitto({ hostId: "remote-host", processId: "remote-process" });
  const target = remote.register(infer("provider-b"), "remote-reasoning");
  const envelopes: InvocationEnvelope[] = [];
  const transport: InvokeTransport = {
    id: "test-rpc",
    async invoke(envelope) {
      envelopes.push(envelope);
      const wire = JSON.parse(JSON.stringify(envelope)) as InvocationEnvelope;
      return structuredClone(await remote.receive(wire));
    },
  };
  const local = createDitto({ hostId: "local-host", transports: [transport] });
  const direct = local.register(infer("provider-a"));
  local.register(defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.OUTPUT": async (input) => input.message,
  } }));
  local.registerRemote({ address: target.address, capabilities: ["REASONING.INFER"], transportId: transport.id });
  assert.equal((await local.run(plan, message)).output.content, "provider-a");
  assert.equal(envelopes.length, 0);
  direct.unregister();
  const result = await local.run(plan, message);
  assert.equal(result.output.content, "provider-b");
  assert.equal(envelopes[0]!.execution!.graphId, "agent");
  assert.equal(envelopes[0]!.execution!.nodeId, "think");
  assert.deepEqual(plan.tasks.map(({ id, node, dependencies }) => ({ id, node, dependencies })), [
    { id: "think", node: "REASONING.INFER", dependencies: [] },
    { id: "output", node: "INTERACTION.OUTPUT", dependencies: ["think"] },
  ]);
});

test("locality routing prefers same host before remote host and skips unavailable instances", async () => {
  const sameHost = createDitto({ hostId: "a", processId: "p2" });
  const remoteHost = createDitto({ hostId: "b", processId: "p3" });
  const near = sameHost.register(infer("near"));
  const far = remoteHost.register(infer("far"));
  const transports: InvokeTransport[] = [
    { id: "ipc", invoke: (envelope) => sameHost.receive(envelope) },
    { id: "rpc", invoke: (envelope) => remoteHost.receive(envelope) },
  ];
  const client = createDitto({ hostId: "a", processId: "p1", transports });
  client.registerRemote({ address: far.address, capabilities: ["REASONING.INFER"], transportId: "rpc" });
  const nearHandle = client.registerRemote({ address: near.address, capabilities: ["REASONING.INFER"], transportId: "ipc" });
  assert.equal((await client.invoke("REASONING.INFER", { messages: [] })).content, "near");
  nearHandle.setAvailable(false);
  assert.equal((await client.invoke("REASONING.INFER", { messages: [] })).content, "far");
});

test("Reference payloads round-trip large inputs and outputs through a shared resolver", async () => {
  const artifacts = new InMemoryArtifactStore();
  const remote = createDitto({ hostId: "b", artifacts, inlineLimitBytes: 8 });
  const worker = remote.register(defineWorker({ type: "REASONING", nodes: {
    "REASONING.INFER": async (input) => input.messages[0]!,
  } }));
  const transport: InvokeTransport = { id: "reference-test", async invoke(envelope) {
    assert.equal(envelope.payload.kind, "reference");
    const result = await remote.receive(envelope);
    assert.equal(result.payload.kind, "reference");
    return result;
  } };
  const local = createDitto({ hostId: "a", artifacts, inlineLimitBytes: 8, transports: [transport] });
  local.registerRemote({ address: worker.address, capabilities: ["REASONING.INFER"], transportId: transport.id });
  const large: Message = { role: "user", content: "x".repeat(100_000) };
  assert.equal(await local.invoke("REASONING.INFER", { messages: [large] }), large);
  const ref = await artifacts.put(large);
  assert.equal(await artifacts.get(ref), large);
  assert.equal(await artifacts.delete(ref), true);
  await assert.rejects(artifacts.get(ref), /not found/);
  await assert.rejects(new PayloadCodec().decode({ kind: "reference", reference: ref }), /requires/);
});

test("Graph runs independent branches concurrently and joins only their declared outputs", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const ditto = createDitto({ workers: [defineWorker({ type: "REASONING", nodes: {
    "REASONING.INFER": async (input) => {
      if (++calls === 2) started.resolve();
      await started.promise;
      return input.messages[0]!;
    },
    "REASONING.DELIBERATE": async (input) => ({ role: "assistant", content: input.messages.length }),
  } })] });
  const plan = graph<Message>()
    .node("a", "REASONING.INFER", [], (input) => ({ messages: [input] }))
    .node("b", "REASONING.INFER", [], (input) => ({ messages: [input] }))
    .node("join", "REASONING.DELIBERATE", ["a", "b"], (_input, outputs) => {
      assert.deepEqual(Object.keys(outputs), ["a", "b"]);
      return { messages: [outputs.a, outputs.b] };
    });
  assert.equal((await ditto.run(plan, message)).join.content, 2);
});

test("Graph rejects bad dependencies and prevents downstream work after failure", async () => {
  const initial = graph<void>().node("first", "REASONING.INFER", [], () => ({ messages: [] }));
  assert.throws(() => initial.node("first", "REASONING.INFER", [], () => ({ messages: [] })), /Duplicate/);
  assert.throws(() => graph<void>().node("a", "REASONING.INFER",
    // @ts-expect-error A dependency must already be declared.
    ["missing"], () => ({ messages: [] })), /Unknown/);
  let downstream = false;
  const plan = initial.node("later", "INTERACTION.OUTPUT", ["first"], (_input, outputs) => ({ message: outputs.first }));
  const ditto = createDitto({ workers: [defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.OUTPUT": async (input) => { downstream = true; return input.message; },
  } })] });
  await assert.rejects(ditto.run(plan, undefined), NoWorkerAvailableError);
  assert.equal(downstream, false);
});

test("transport correlation, missing adapter and forged target fail explicitly", async () => {
  const remote = createDitto({ hostId: "b" });
  const worker = remote.register(infer("remote"));
  const client = createDitto({ transports: [{ id: "bad", async invoke() {
    return { invocationId: "wrong", payload: { kind: "inline", value: message } };
  } }] });
  assert.throws(() => client.registerRemote({ address: worker.address, capabilities: ["REASONING.INFER"], transportId: "missing" }), /not installed/);
  client.registerRemote({ address: worker.address, capabilities: ["REASONING.INFER"], transportId: "bad" });
  await assert.rejects(client.invoke("REASONING.INFER", { messages: [] }), /mismatched invocation/);
  await assert.rejects(remote.receive({
    id: "test", target: { ...worker.address, processId: "forged" }, node: "REASONING.INFER",
    payload: { kind: "inline", value: { messages: [] } },
  }), /mismatched/);
});
