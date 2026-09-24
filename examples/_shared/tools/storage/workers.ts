import { join } from "node:path";
import type { RuntimeConfig } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { openRedisContext } from "./redis-context.ts";
import { openSqliteMemory } from "./sqlite-memory.ts";

export async function openAgentStorage(directory: string, config: RuntimeConfig) {
  const redis = await openRedisContext();
  try {
    const memory = openSqliteMemory(join(directory, "memory.sqlite"));
    return {
      redis,
      workers: [
        createContextWorker({ ...(config.context.policy ? { policy: config.context.policy } : {}), redis: { client: redis, ...config.context.cache } }),
        createMemoryWorker({ store: memory.store, defaults: config.memory, concurrency: 1 }),
      ],
      async close() { try { await memory.close(); } finally { if (redis.isOpen) await redis.quit(); } },
    };
  } catch (error) { if (redis.isOpen) await redis.quit(); throw error; }
}
