import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createDitto, createMemoryWorker, loadRuntimeConfigFile, type NodeResult } from "@ditto/core";
import type { MemoryResources, MemoryDraft } from "@ditto/core/worker/memory";

/** Optional SDKs belong to the example application, not Ditto Core. */
export function exampleSdk(name: string): unknown {
  const directory = process.env.DITTO_EXAMPLES_SDK_DIRECTORY;
  const require = createRequire(directory ? resolve(directory, "package.json") : import.meta.url);
  return require(name);
}

export function result<T>(value: NodeResult<T>): T {
  if (value.status !== "success" || value.output === undefined) throw new Error(value.error?.code ?? value.status);
  return value.output;
}

/** The same six operations work against any injected storage adapter. */
export async function runMemoryExample(resources: MemoryResources, query: unknown, drafts: MemoryDraft[]) {
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const runtime = createDitto({ config, workers: [createMemoryWorker({ ...resources, concurrency: 1 })] });
  try {
    const written = result(await runtime.invoke("MEMORY.WRITE", { memories: drafts }));
    const id = written[0]!.id;
    assert.equal(written.length, drafts.length);
    const read = result(await runtime.invoke("MEMORY.GET", { ids: [id] }));
    assert.deepEqual(read[0]?.content, drafts[0]!.content);
    const byKey = result(await runtime.invoke("MEMORY.GET", { keys: [drafts[0]!.key!] }));
    assert.ok(byKey.some(item => item.id === id));
    const page = result(await runtime.invoke("MEMORY.QUERY", { limit: 1 }));
    assert.equal(page.items.length, 1);
    if (page.nextCursor) {
      const next = result(await runtime.invoke("MEMORY.QUERY", { limit: 1, cursor: page.nextCursor }));
      assert.equal(next.items.length, 1);
      assert.notEqual(next.items[0]!.id, page.items[0]!.id);
    }
    const hits = result(await runtime.invoke("MEMORY.SEARCH", { query, limit: 2 }));
    assert.ok(hits.some(hit => hit.memory.id === id));
    const updated = result(await runtime.invoke("MEMORY.UPDATE", { memories: [{ id, metadata: { reviewed: true } }] }));
    assert.deepEqual(updated[0]?.metadata, { reviewed: true });
    assert.deepEqual(updated[0]?.content, drafts[0]!.content);
    const deleted = result(await runtime.invoke("MEMORY.DELETE", { ids: written.map(item => item.id) }));
    assert.equal(deleted.deleted.length, written.length);
    assert.deepEqual(result(await runtime.invoke("MEMORY.DELETE", { ids: [id] })).deleted, []);
    assert.deepEqual(result(await runtime.invoke("MEMORY.GET", { ids: [id] })), []);
    console.log(JSON.stringify({ written: written.length, page, hits, updated, deleted }, null, 2));
  } finally { await runtime.close(); }
}
