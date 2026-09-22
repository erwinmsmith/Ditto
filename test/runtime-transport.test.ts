import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createDitto, createHttpTransport, createIpcTransport, defineWorker, graph,
  type WorkerAddress, type InvocationEnvelope,
} from "../src/index.js";

test("real child IPC and HTTP run one graph with route bindings, correlation and execution scope", async () => {
  const token = randomUUID();
  const child = fork(new URL("./fixtures/runtime-worker.js", import.meta.url), [], {
    env: { ...process.env, TEST_WORKER_TOKEN: token }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exit = once(child, "exit");
  let ipc: ReturnType<typeof createIpcTransport> | undefined;
  let runtime: ReturnType<typeof createDitto> | undefined;
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ worker: WorkerAddress; url: string }];
    ipc = createIpcTransport({ id: "ipc", channel: child, timeoutMs: 1000 });
    const http = createHttpTransport({ id: "http", url: ready.url, token });
    // Separate directory IDs on the caller are unnecessary: the same remote address can
    // be registered in separate runtimes using the desired channel.
    runtime = createDitto({ hostId: "same-host", transports: [ipc, http] });
    runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: ipc.id, concurrency: 4 });
    runtime.register(defineWorker({ type: "CONTEXT", nodes: {
      "CONTEXT.LOAD": async ({ sources }) => ({ items: (sources ?? []).map((s, i) => ({ id: String(i), content: String("content" in s ? s.content : s.uri) })) }),
    } }), "local-context");
    const plan = graph<string>("remote-graph")
      .node("read", "MEMORY.GET", [], id => ({ ids: [id] }))
      .node("load", "CONTEXT.LOAD", ["read"], (_input, { read }) => ({ sources: [{ role: "user", content: String(read.output![0]!.content) }] }));
    for (const transport of [ipc, http]) {
      if (transport === http) {
        await runtime.close();
        runtime = createDitto({ hostId: "other-host", transports: [http] });
        runtime.registerRemote({ address: ready.worker, capabilities: ["MEMORY.GET"], transportId: http.id });
        runtime.register(defineWorker({ type: "CONTEXT", nodes: {
          "CONTEXT.LOAD": async ({ sources }) => ({ items: (sources ?? []).map((s, i) => ({ id: String(i), content: String("content" in s ? s.content : s.uri) })) }),
        } }), "local-context");
      }
      const result = await runtime.run(plan, "hello", { workers: { read: ready.worker.workerId, load: "local-context" } });
      const data = JSON.parse(result.load.items[0]!.content as string);
      assert.equal(data.pid, child.pid); assert.notEqual(data.pid, process.pid);
      assert.deepEqual(data.ids, ["hello"]); assert.equal(data.execution.graphId, "remote-graph");
      assert.equal(data.execution.nodeId, "read"); assert.ok(data.execution.runId);
    }
    const envelope = (id = randomUUID()): InvocationEnvelope => ({ id, node: "MEMORY.GET", target: ready.worker,
      payload: { kind: "inline", value: { ids: ["slow"] } } });
    const controller = new AbortController();
    const cancelled = ipc.invoke(envelope(), { signal: controller.signal });
    controller.abort(new Error("caller cancelled"));
    await assert.rejects(cancelled, /caller cancelled/);
    const timed = createIpcTransport({ id: "short", channel: child, timeoutMs: 1 });
    try { await assert.rejects(timed.invoke(envelope()), /timed out/); } finally { timed.close(); }
    const jobs = [ipc.invoke(envelope()), ipc.invoke(envelope())];
    const settled = Promise.allSettled(jobs);
    ipc.close();
    assert.ok((await settled).every(result => result.status === "rejected"));
    await assert.rejects(ipc.invoke(envelope()), /closed/);
  } finally {
    await runtime?.close(); ipc?.close();
    if (child.connected) child.send("shutdown");
    const timer = setTimeout(() => child.kill(), 3000);
    try { await exit; } finally { clearTimeout(timer); }
  }
});

test("router prefers local, same-host IPC, then cross-host HTTP without changing the graph", async () => {
  const selected: string[] = [];
  const runtime = createDitto({ hostId: "host", transports: [{ id: "fixture", async invoke(envelope) {
    selected.push(envelope.target.workerId);
    return { invocationId: envelope.id, payload: { kind: "inline", value: { items: [] } } };
  } }] });
  const local = runtime.register(defineWorker({ type: "CONTEXT", nodes: {
    "CONTEXT.LOAD": async () => { selected.push("local"); return { items: [] }; },
  } }));
  const same = runtime.registerRemote({ address: { workerId: "same", workerType: "CONTEXT", hostId: "host", processId: "other" },
    capabilities: ["CONTEXT.LOAD"], transportId: "fixture" });
  runtime.registerRemote({ address: { workerId: "remote", workerType: "CONTEXT", hostId: "other", processId: "other" },
    capabilities: ["CONTEXT.LOAD"], transportId: "fixture" });
  const plan = graph<void>().node("load", "CONTEXT.LOAD", [], () => ({ sources: [] }));
  try {
    await runtime.run(plan, undefined); local.setAvailable(false);
    await runtime.run(plan, undefined); same.setAvailable(false);
    await runtime.run(plan, undefined);
    assert.deepEqual(selected, ["local", "same", "remote"]);
  } finally { await runtime.close(); }
});
