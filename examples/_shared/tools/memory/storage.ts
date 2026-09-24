import { join } from "node:path";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createHttpEmbeddingProvider, embeddingConfigFromEnv, type EmbeddingProvider } from "@codesoul-co/ditto-retrieval";
import type { RuntimeConfig } from "@codesoul-co/ditto/runtime";
import { openRedisContext } from "../storage/redis-context.ts";
import { openSqliteMemory } from "../storage/sqlite-memory.ts";
import { openPostgresMemory } from "../storage/postgres-memory.ts";
import { openQdrantMemory } from "../storage/qdrant-memory.ts";
import { scopedMemory } from "../storage/scoped-memory.ts";
import type { Backend } from "./domain.ts";
export interface StorageInput { backend: Backend; directory: string; namespace: string; config: RuntimeConfig; embedding?: EmbeddingProvider }
export async function openMemoryStorage(input: StorageInput) {
  const { directory, backend, config, namespace } = input;
  const redis = await openRedisContext();
  try {
    const database: ReturnType<typeof openSqliteMemory> & Partial<Pick<Awaited<ReturnType<typeof openQdrantMemory>>, "client" | "stats">> = backend === "sqlite" ? openSqliteMemory(join(directory, "memory.sqlite")) : backend === "postgres" ? await openPostgresMemory(required("DITTO_WORKER_MEMORY_POSTGRES_URL"), process.env.DITTO_WORKER_MEMORY_POSTGRES_TABLE ?? "agent_memories") : await vector();
    const store = scopedMemory(database.store, namespace);
    return { redis, database, workers: [createContextWorker({ ...(config.context.policy ? { policy: config.context.policy } : {}), redis: { client: redis, ...config.context.cache } }), createMemoryWorker({ store, defaults: config.memory, concurrency: 1 })],
      async close() { try { await database.close(); } finally { if (redis.isOpen) await redis.quit(); } },
    };
    async function vector() {
      const embedding = embeddingConfigFromEnv(process.env), url = required("DITTO_WORKER_MEMORY_QDRANT_URL"), dimensions = Number(required("DITTO_WORKER_MEMORY_EMBEDDING_DIMENSIONS"));
      return openQdrantMemory({ url, collection: process.env.DITTO_WORKER_MEMORY_QDRANT_COLLECTION ?? "agent_memories", dimensions, embeddingIdentity: `${embedding.baseUrl}:${embedding.model}`, ...(process.env.DITTO_WORKER_MEMORY_QDRANT_API_KEY ? { apiKey: process.env.DITTO_WORKER_MEMORY_QDRANT_API_KEY } : {}),
        embedding: input.embedding ?? createHttpEmbeddingProvider({ ...embedding, sandbox: new Sandbox(directory, { ...config.sandbox, network: [...(config.sandbox?.network ?? []), new URL(embedding.baseUrl).origin] }) }),
      });
    }
  } catch (error) { if (redis.isOpen) await redis.quit(); throw error; }
}
function required(key: string) { const value = process.env[key]; if (!value) throw new Error(`Set ${key}`); return value; }
