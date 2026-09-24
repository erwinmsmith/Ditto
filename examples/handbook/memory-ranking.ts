import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDitto, graph } from "@codesoul-co/ditto/runtime";
import { createMemoryWorker, MemoryError, type MemoryStore, type MemorySearchProvider } from "@codesoul-co/ditto/worker/memory";
import { openSqliteMemory } from "../_shared/tools/storage/sqlite-memory.ts";

/** Reorder candidates returned by the database; never invent a Memory record. */
export function recencySearch(store: MemoryStore & MemorySearchProvider, now = Date.now()): MemorySearchProvider {
  return { async search(input, options) {
    if (input.strategy !== "recent-keyword" || typeof input.query !== "string") {
      throw new MemoryError("INVALID_INPUT", "Expected recent-keyword and a text query");
    }
    if (Object.keys(input.options ?? {}).length) throw new MemoryError("INVALID_INPUT", "Unsupported search options");
    const limit = input.limit ?? 10;
    if (limit === 0) return [];
    const candidates = await store.search({ ...input, strategy: "keyword", limit: Math.min(limit * 4, 100) }, options);
    return candidates.map(candidate => {
      const savedAt = candidate.memory.metadata?.savedAt;
      const timestamp = typeof savedAt === "string" ? Date.parse(savedAt) : NaN;
      const ageDays = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 86_400_000) : Infinity;
      return { ...candidate, score: 1 / (1 + ageDays) };
    }).sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, limit);
  } };
}
export async function runMemoryRanking(directory = ".examples-handbook-tasks") {
  await mkdir(directory, { recursive: true });
  const database = openSqliteMemory(resolve(directory, "ranking.sqlite"));
  const runtime = createDitto({ workers: [createMemoryWorker({ store: database.store,
    search: recencySearch(database.store, Date.parse("2026-09-01T00:00:00Z")) })] });
  const plan = graph("write-and-recall")
    .node("written", "MEMORY.WRITE", [], () => ({ memories: [
      { key: "handbook:older", content: "Redis is working context storage", metadata: { namespace: "handbook", savedAt: "2026-01-01T00:00:00Z" } },
      { key: "handbook:newer", content: "Redis context expires; restore history from Memory", metadata: { namespace: "handbook", savedAt: "2026-08-31T00:00:00Z" } },
    ] }))
    .node("found", "MEMORY.SEARCH", ["written"], (_input, { written }) => {
      if (written.status !== "success") throw new Error(written.error?.message ?? "Memory write failed");
      return { query: "Redis", filter: { namespace: "handbook" }, strategy: "recent-keyword", limit: 2 };
    });
  try { return await runtime.run(plan, undefined); }
  finally { try { await runtime.close(); } finally { await database.close(); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runMemoryRanking(process.argv[2]), null, 2));
