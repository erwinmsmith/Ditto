import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, createWorkerHttpHandler, defineWorker, serveWorkerIpc } from "../../src/index.js";

const runtime = createDitto({ hostId: "same-host", processId: "child", workers: [] });
const worker = runtime.register(defineWorker({ type: "MEMORY", nodes: {
  "MEMORY.GET": async ({ ids }, ctx) => {
    if (ids?.[0] === "slow") await delay(100);
    return { executionId: "fixture", node: "MEMORY.GET", status: "success", output: [{ id: "result",
      content: JSON.stringify({ pid: process.pid, ids, execution: ctx.execution }) }] };
  },
} }), "child-memory");
const ipc = serveWorkerIpc(runtime, process);
const server = createServer(createWorkerHttpHandler(runtime, { token: process.env.TEST_WORKER_TOKEN! }));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  process.send!({ kind: "ready", worker: worker.address, url: `http://127.0.0.1:${address.port}/ditto/invoke` });
});
process.on("message", value => {
  if (value !== "shutdown") return;
  void (async () => {
    await ipc.close(); await runtime.close();
    server.close(() => { process.disconnect(); });
  })();
});
