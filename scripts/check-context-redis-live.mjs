/** Explicit real Redis check. Pass an external directory with npm package redis installed. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, createContextWorker, createDitto, createHttpTransport, createWorkerHttpHandler, createRedisContextStore, contextScopeKey } from "@ditto/core";

if (!process.argv[2]) throw new Error("Pass an external directory containing the redis SDK");
const requireSdk = createRequire(join(resolve(process.argv[2]), "package.json"));
const { createClient } = requireSdk("redis");
const client = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL ?? "redis://127.0.0.1:6379",
  socket: { connectTimeout: 5000, reconnectStrategy: false },
});
client.on("error", () => {}); // Connection failures are reported through awaited operations.
const keyPrefix = `ditto:check:${randomUUID()}:`;
const scope = { sessionId: "one", turnId: "one" };
const key = keyPrefix + contextScopeKey(scope);
let runtime;
let remote;
let server;
try {
  await client.connect();
  const store = createRedisContextStore(client, { keyPrefix, ttlMs: 10000 });
  const a = createContext({ services: { stateStore: store } });
  const b = createContext({ redis: { client, keyPrefix, ttlMs: 10000 } });
  await a.load({ scope, sources: [{ id: "seed", content: "中文 context" }] });
  assert.equal((await b.load({ scope })).items[0].content, "中文 context");
  assert.ok(await client.pTTL(key) > 0);
  const version = (await store.get(scope)).version;
  const results = await Promise.allSettled([
    a.update({ scope, expectedVersion: version, add: [{ id: "a", content: "A" }] }),
    b.update({ scope, expectedVersion: version, add: [{ id: "b", content: "B" }] }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(results.some(result => result.status === "rejected" && result.reason.code === "STATE_CONFLICT"));
  assert.equal((await a.load({ scope })).items.length, 2);
  await b.select({ scope, purpose: "infer", limit: 0 });
  assert.equal((await a.load({ scope })).items.length, 2);
  runtime = createDitto({ workers: [createContextWorker({ redis: { client, keyPrefix, ttlMs: 10000 } })] });
  server = createServer(createWorkerHttpHandler(runtime, { token: "context-check" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  remote = createDitto({ transports: [createHttpTransport({ id: "http", token: "context-check",
    url: `http://127.0.0.1:${server.address().port}/ditto/invoke`,
  })] });
  const worker = runtime.workers()[0];
  remote.registerRemote({ address: worker.address, capabilities: worker.capabilities, transportId: "http" });
  await remote.invoke("CONTEXT.COMPRESS", { scope, maxItems: 1 });
  assert.equal((await b.load({ scope })).items.length, 1);
  // Real TTL expiry, then stale CAS must fail even if the same scope is recreated.
  await client.pExpire(key, 30);
  await delay(60);
  assert.equal(await store.get(scope), undefined);
  await assert.rejects(a.load({ scope }), error => error.code === "CONTEXT_NOT_FOUND");
  await a.load({ scope, sources: [] });
  await assert.rejects(store.compareAndSet(scope, version, { items: [] }), error => error.code === "STATE_CONFLICT");
  // JSON is stored as opaque text, avoiding Lua cjson empty-array coercion.
  await a.load({ scope, sources: [{ id: "array", content: [] }] });
  assert.deepEqual((await b.load({ scope })).items[0].content, []);
  console.log("Redis Context: cross-client reads, CAS conflict, SELECT, HTTP Worker, TTL and JSON round trips passed.");
} finally {
  await remote?.close();
  await runtime?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (client.isReady) await client.del(key);
  if (client.isOpen) await client.quit();
}
