import { createRequire } from "node:module";
import type { RedisContextClient } from "@ditto/core/worker/context";
export interface RedisClient extends RedisContextClient {
  isOpen: boolean;
  connect(): Promise<unknown>; quit(): Promise<unknown>;
  del(key: string): Promise<unknown>; pTTL(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<unknown>;
  on(event: "error", handler: (error: Error) => void): unknown;
}

/** The Redis SDK is an application dependency installed alongside this adapter. */
export async function openRedisContext(url = process.env.DITTO_WORKER_CONTEXT_REDIS_URL ?? "redis://127.0.0.1:6379") {
  const require = createRequire(new URL("./dependencies/package.json", import.meta.url));
  const { createClient } = require("redis") as { createClient(options: object): RedisClient };
  const client = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => {}); // Awaited operations surface failures to the controller.
  try { await client.connect(); return client; }
  catch (error) { if (client.isOpen) await client.quit(); throw error; }
}
