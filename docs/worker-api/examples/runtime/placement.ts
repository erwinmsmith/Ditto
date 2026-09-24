import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  createContextWorker, createDitto, createHttpTransport, createIpcTransport,
  createWorkerHttpHandler, graph, serveWorkerIpc, type WorkerAddress,
} from "@ditto/core";

// This file is both the application entrypoint and a separately started Worker host.
// The HTTP child runs on loopback for the demo; production can use a host on another machine.
if (process.argv[2] === "worker") {
  const mode = process.argv[3]!;
  const runtime = createDitto({ hostId: mode === "ipc" ? "machine-a" : "machine-b", processId: mode });
  const handle = runtime.register(createContextWorker(), `context-${mode}`);
  const ipc = mode === "ipc" ? serveWorkerIpc(runtime, process) : undefined;
  const server = mode === "http" ? createServer(createWorkerHttpHandler(runtime, {
    token: process.env.DITTO_TRANSPORT_HTTP_WORKER_TOKEN!,
  })) : undefined;
  let url: string | undefined;
  if (server) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    url = `http://127.0.0.1:${address.port}/ditto/invoke`;
  }
  process.send!({ address: handle.address, url, pid: process.pid });
  process.on("message", value => {
    if (value !== "shutdown") return;
    void (async () => {
      await ipc?.close(); await runtime.close();
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      process.disconnect();
    })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
  });
} else {
  const token = randomUUID(); // Ephemeral demo credential, never committed or logged.
  const children: ReturnType<typeof fork>[] = [];
  const transports: (ReturnType<typeof createIpcTransport> | ReturnType<typeof createHttpTransport>)[] = [];
  const runtime = createDitto({ hostId: "machine-a", workers: [createContextWorker()] });
  let distributed: ReturnType<typeof createDitto> | undefined;
  try {
    const endpoints: { address: WorkerAddress; transportId: string }[] = [];
    for (const mode of ["ipc", "http"] as const) {
      const child = fork(new URL(import.meta.url), ["worker", mode], {
        env: { ...process.env, DITTO_TRANSPORT_HTTP_WORKER_TOKEN: token }, stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) }) as [{ address: WorkerAddress; url?: string; pid: number }];
      console.log(`${mode} Worker PID`, ready.pid);
      const transport = mode === "ipc" ? createIpcTransport({ id: mode, channel: child })
        : createHttpTransport({ id: mode, url: ready.url!, token });
      transports.push(transport); endpoints.push({ address: ready.address, transportId: mode });
    }
    distributed = createDitto({ hostId: "machine-a", transports });
    for (const endpoint of endpoints) distributed.registerRemote({ ...endpoint, capabilities: ["CONTEXT.LOAD"], concurrency: 4 });
    const plan = graph<string>("portable").node("load", "CONTEXT.LOAD", [], content => ({ sources: [{ role: "user", content }] }));
    // Exactly the same graph: direct call, same-machine IPC, cross-machine HTTP protocol.
    console.log("direct", await runtime.run(plan, "direct"));
    for (const endpoint of endpoints) console.log(endpoint.transportId, await distributed.run(plan, endpoint.transportId, {
      workers: { load: endpoint.address.workerId },
    }));
  } finally {
    await runtime.close(); await distributed?.close();
    for (const transport of transports) if ("close" in transport) transport.close();
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      if (child.connected) child.send("shutdown");
      const timer = setTimeout(() => child.kill(), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
  }
}
