import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createContextWorker, createDitto, loadRuntimeConfigFile, contextScopeKey,
  type RedisContextClient,
} from "@codesoul-co/ditto";
import { exampleSdk } from "./shared.ts";

type Client = RedisContextClient & {
  isOpen: boolean; connect(): Promise<unknown>; quit(): Promise<unknown>;
  del(key: string): Promise<unknown>; on(event: "error", handler: (error: Error) => void): unknown;
};

export async function main() {
  const { createClient } = exampleSdk("redis") as { createClient(options: object): Client };
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const client = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL ?? "redis://127.0.0.1:6379",
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  client.on("error", () => {}); // Awaited calls report errors; attach application logging here.
  const scope = { sessionId: `example:${randomUUID()}`, turnId: "1" };
  const runtime = createDitto({ config, workers: [createContextWorker({
    ...(config.context.policy ? { policy: config.context.policy } : {}),
    redis: { client, ...config.context.cache },
  })] });
  try {
    await client.connect();
    await runtime.invoke("CONTEXT.LOAD", { scope, sources: [{ id: "goal", content: "Explain Redis", metadata: { currentGoal: true } }] });
    await runtime.invoke("CONTEXT.UPDATE", { scope, add: [{ id: "evidence", content: "Context supports TTL and CAS." }] });
    const selected = await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer", limit: 1 });
    assert.deepEqual(selected.selectedItemIds, ["goal"]);
    assert.equal((await runtime.invoke("CONTEXT.LOAD", { scope })).items.length, 2);
    const compressed = await runtime.invoke("CONTEXT.COMPRESS", { scope, maxItems: 1 });
    assert.equal(compressed.items.length, 1);
    console.log(JSON.stringify({ selected, restored: await runtime.invoke("CONTEXT.LOAD", { scope }) }, null, 2));
  } finally {
    await runtime.close();
    if (client.isOpen) {
      try { await client.del((config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope)); }
      finally { await client.quit(); }
    }
  }
}

if (import.meta.main) await main();
