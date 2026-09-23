import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import {
  createContextWorker, createDitto, createInMemoryContextStore, createContextOperationQueue,
  graph, loadRuntimeConfigFile,
} from "@ditto/core";
import { createRetrievalWorker, createSqlSearchProvider, RetrievalTargetRegistry } from "@ditto/core/worker/retrieval";
import { createRetrievalContextStrategy } from "@ditto/core/worker/retrieval/adapters/context";

/** Real SQLite FTS5, shared by inline CONTEXT retrieval and the optional RETRIEVAL Worker. */
export async function main() {
  const database = new DatabaseSync(":memory:");
  const config = loadRuntimeConfigFile("ditto.yaml", process.env);
  const runtime = createDitto({ config });
  try {
    database.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
    const insert = database.prepare("INSERT INTO docs(content) VALUES (?)");
    for (const text of ["Context caches temporary working state", "Retrieval can execute database search", "Graph connects worker nodes"]) insert.run(text);
    const provider = createSqlSearchProvider<{ id: number; content: string; score: number }>({
      prepare(input) {
        if (typeof input.query.content !== "string" || input.filter || input.target.namespace) throw new Error("Example requires a text query without filter/namespace");
        // Treat user input as a literal FTS phrase; bind values rather than interpolating SQL.
        return { text: "SELECT rowid AS id, content, -bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY bm25(docs), rowid LIMIT ?",
          values: [`"${input.query.content.replaceAll('"', '""')}"`, input.limit!] };
      },
      async query(statement) { return database.prepare(statement.text).all(...statement.values as (string | number)[]) as { id: number; content: string; score: number }[]; },
      mapRow: row => ({ id: String(row.id), content: row.content, score: row.score, source: { ref: `urn:docs:${row.id}` } }),
    });
    runtime.register(createRetrievalWorker({ providers: new RetrievalTargetRegistry({ docs: {
      defaultStrategy: "fts", providers: { fts: provider },
    } }) }));
    const stateStore = createInMemoryContextStore(config.context.localCache);
    const operationQueue = createContextOperationQueue(config.context.queue);
    const outputs = [];
    for (const mode of ["inline", "worker"] as const) {
      const handle = runtime.register(createContextWorker({ ...(config.context.policy ? { policy: config.context.policy } : {}), services: {
        stateStore, operationQueue,
        referenceResolver: { async resolve(reference, options) {
          if (reference.uri !== "urn:ditto:readme") throw new Error("Unknown reference");
          return readFile(new URL("../../README.md", import.meta.url), { encoding: "utf8", signal: options?.signal });
        } },
        ragStrategy: createRetrievalContextStrategy({ target: { name: "docs" }, strategy: "fts",
          ...(mode === "inline" ? { provider } : {}) }),
      } }), `context-${mode}`);
      const plan = graph<{ query: string }>()
        .node("load", "CONTEXT.LOAD", [], () => ({ scope: { sessionId: mode }, resolveReferences: true,
          sources: [{ uri: "urn:ditto:readme" }] }))
        .node("select", "CONTEXT.SELECT", ["load"], input => ({ scope: { sessionId: mode }, purpose: "infer",
          query: input.query, limit: 2, strategy: { kind: "rag" } }));
      const result = await runtime.run(plan, { query: "database" }, { workers: { load: handle.address.workerId, select: handle.address.workerId } });
      assert.equal(result.select.context.items[0]?.content, "Retrieval can execute database search");
      const restored = await runtime.invoke("CONTEXT.LOAD", { scope: { sessionId: mode } }, { workerId: handle.address.workerId });
      assert.equal(restored.items[0]?.source?.uri, "urn:ditto:readme"); // SELECT does not overwrite cached state.
      outputs.push(result.select);
    }
    assert.deepEqual(outputs[0], outputs[1]);
    console.log(JSON.stringify({ inline: outputs[0], worker: outputs[1] }, null, 2));
  } finally { await runtime.close(); database.close(); }
}

if (import.meta.main) await main();
