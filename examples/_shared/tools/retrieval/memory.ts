/** Explicit knowledge ingestion through the public Memory Worker, separate from task checkpoints. */
import { graph, type DittoRuntime } from "@ditto/core/runtime";
import { json, object, text } from "./domain.ts";
export interface KnowledgeRecord { key: string; title: string; text: string }
const ingest = graph<{ tenant: string; records: KnowledgeRecord[] }>("internal-knowledge-ingestion")
  .node("saved", "MEMORY.WRITE", [], i => ({ memories: i.records.map(record => ({ key: record.key, content: json({ kind: "knowledge", tenant: i.tenant, title: record.title, text: record.text }) })) }));
/** A trusted application explicitly approves these facts for long-term knowledge storage. */
export async function importInternalKnowledge(runtime: Pick<DittoRuntime, "run">, tenant: string, values: unknown) {
  if (!/^[a-zA-Z0-9_-]+$/.test(tenant) || !Array.isArray(values) || !values.length || values.length > 100) throw new Error("Invalid knowledge ingestion");
  const records = values.map(value => { const r = object(value), key = text(r.key, 128); if (!key.startsWith(`knowledge:${tenant}:`) || !/^[a-zA-Z0-9:_-]+$/.test(key)) throw new Error("Knowledge key outside tenant"); return { key, title: text(r.title, 256), text: text(r.text, 1000) }; });
  if (new Set(records.map(r => r.key)).size !== records.length) throw new Error("Duplicate knowledge key");
  const result = (await runtime.run(ingest, { tenant, records })).saved;
  if (result.status !== "success") throw new Error(`Knowledge ingestion failed: ${result.error?.code ?? result.status}`);
  return result.output;
}
