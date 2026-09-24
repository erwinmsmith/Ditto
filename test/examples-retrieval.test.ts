import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createDitto, graph } from "@ditto/core/runtime";
import { createContextWorker, createInMemoryContextStore } from "@ditto/core/worker/context";
import { createMemoryWorker } from "@ditto/core/worker/memory";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { openSqliteMemory } from "../examples/_shared/tools/storage/sqlite-memory.ts";
import { importInternalKnowledge } from "../examples/_shared/tools/retrieval/memory.ts";
import { RetrievalAdapters } from "../examples/_shared/tools/retrieval/adapters.ts";
import { request, queries, findings, type Evidence, type Mode, type Report, type Request } from "../examples/_shared/tools/retrieval/domain.ts";
import { approvedUrl } from "../examples/_shared/tools/retrieval/web.ts";
import { createFixture } from "../examples/capabilities/retrieval/fixtures.ts";
import { runRetrieval, collect, prepareContext } from "../examples/capabilities/retrieval/shared.ts";
async function setup(mode: Mode = "document-search", change: Partial<Request> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ditto-retrieval-test-")), fixture = await createFixture(dir, mode, change), r = fixture.request;
  const adapters = new RetrievalAdapters(dir, r), memory = openSqliteMemory(join(dir, "memory.sqlite")); let calls = 0;
  const runtime = createDitto({ sandbox: { tools: adapters.tools.map(t => t.name) }, workers: [
    createContextWorker({ services: { stateStore: createInMemoryContextStore() } }), createMemoryWorker({ store: memory.store }), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools }),
    createInferWorker({ providers: { unit: { async invoke(input) {
      calls++; const items = JSON.parse(String(input.messages[1]!.content)) as { id: string; content: { value: { evidence: Evidence[] } } }[];
      const e = items.find(i => i.id === "evidence"); const result = e ? { findings: e.content.value.evidence.map(e => ({ sourceId: e.id, quote: e.text })) } : { queries: mode === "expand" ? ["retention", "backup"] : mode === "rewrite" ? ["retention"] : [r.query] };
      return { message: { role: "assistant", content: JSON.stringify(result) }, finishReason: "stop" };
    } } } }),
  ] });
  if (r.knowledge !== "external") await importInternalKnowledge(runtime, r.tenant, fixture.internalKnowledge);
  return { ...fixture, dir, adapters, runtime, calls: () => calls, run: (stopAfter?: "evidence") => runRetrieval(runtime, { request: r, model: { provider: "unit", model: "unit" } }, stopAfter ? { stopAfter } : {}), async close() { await runtime.close(); await memory.close(); adapters.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("five local retrieval modes produce traceable real file/FTS reports with explicit unit model and local test Context", async () => {
  for (const mode of ["document-search", "knowledge-base", "rewrite", "expand", "source-location"] as const) {
    const s = await setup(mode); try { const result = await s.run() as Report; assert.equal(result.status, "completed"); assert.equal(s.calls(), 2); assert.deepEqual(JSON.parse(await readFile(join(s.dir, "artifacts/brief.json"), "utf8")), result); assert.deepEqual(await s.run(), result); assert.equal(s.calls(), 2); assert.ok((await prepareContext(s.runtime, s.request)).items.some(i => i.id === "report")); } finally { await s.close(); }
  }
});
test("rewriting repairs an empty colloquial lookup and expansion retrieves both policy facts", async () => {
  const s = await setup("rewrite"); try { assert.equal((await collect(s.runtime, s.request, [s.request.query])).evidence.length, 0); assert.ok((await collect(s.runtime, s.request, ["retention"])).evidence.length); const expanded = await collect(s.runtime, s.request, ["retention", "backup"]); assert.equal(expanded.evidence.length, 2); } finally { await s.close(); }
});
test("SQL full-text retrieval enforces trusted tenant and safely binds query syntax", async () => {
  const s = await setup("knowledge-base"); const search = graph<{ tenant: string; query: string }>().node("result", "RETRIEVAL.SEARCH", [], i => ({ target: { name: "knowledge-external", namespace: i.tenant }, query: { content: i.query } }));
  try { const ok = await s.runtime.run(search, { tenant: "team-a", query: "retention" }); assert.equal(ok.result.status, "success"); assert.equal(ok.result.output!.candidates.length, 1); assert.ok(!JSON.stringify(ok).includes("CONFIDENTIAL_TEAM_B")); assert.equal((await s.runtime.run(search, { tenant: "team-b", query: "retention" })).result.status, "failed"); const injected = await s.runtime.run(search, { tenant: "team-a", query: "retention' OR 1=1 --" }); assert.equal(injected.result.status, "success"); assert.equal(injected.result.output!.candidates.length, 0); } finally { await s.close(); }
});
test("document selection rejects traversal, symlinks and source failure without publishing invented evidence", async () => {
  const s = await setup(); try { assert.throws(() => request({ ...s.request, documents: ["../outside.md"] })); await rm(join(s.dir, "policy.md")); await symlink(join(s.dir, "request.json"), join(s.dir, "policy.md")); await assert.rejects(s.run(), /Required retrieval failed/); assert.equal(await readFile(join(s.dir, "artifacts/brief.json")).then(() => true, () => false), false); } finally { await s.close(); }
});
test("citation validation rejects fabricated IDs, paraphrases, duplicates and missing passages", () => {
  const e: Evidence = { id: "e1", source: "documents", uri: "file:policy.md", title: "policy", text: "Retention is 35 days and backups run every 3 hours.", location: "line 3", snapshot: "hash", queries: ["retention"] };
  assert.equal(findings({ findings: [{ sourceId: "e1", quote: e.text }] }, [e]).length, 1);
  for (const f of [[{ sourceId: "missing", quote: e.text }], [{ sourceId: "e1", quote: "Retention is 999 days and no backups are needed." }], [], [{ sourceId: "e1", quote: e.text }, { sourceId: "e1", quote: e.text }]]) assert.throws(() => findings({ findings: f }, [e]));
});
test("query plans cannot alter fixed topics or evade expansion bounds", async () => {
  const s = await setup(); try { for (const value of [{ queries: [] }, { queries: ["changed"] }, { queries: ["retention", "backup"] }]) assert.throws(() => queries(value, s.request)); assert.throws(() => queries({ queries: ["retention", "retention"] }, { ...s.request, mode: "expand" })); } finally { await s.close(); }
});
test("checkpoint recovery uses archived evidence even when original documents change", async () => {
  const s = await setup(); try { await s.run("evidence"); await writeFile(join(s.dir, "policy.md"), "New unsupported content."); const result = await s.run() as Report; assert.ok(result.evidence[0]!.text.includes(`${s.retentionDays} days`)); assert.equal(s.calls(), 2); } finally { await s.close(); }
});
test("all failed sources never become a no-evidence or successful partial result", async () => {
  const s = await setup(); try { await rm(join(s.dir, "policy.md")); await assert.rejects(collect(s.runtime, { ...s.request, allowPartial: true }, ["retention"]), /Required retrieval failed/); } finally { await s.close(); }
});
test("page origins require exact trusted HTTPS origins, never suffix or credential matches", () => {
  const origins = ["https://www.sqlite.org"]; assert.equal(approvedUrl("https://www.sqlite.org/fts5.html#section", origins).href, "https://www.sqlite.org/fts5.html");
  for (const url of ["http://www.sqlite.org/", "https://www.sqlite.org.evil.test/", "https://user:pass@www.sqlite.org/", "https://127.0.0.1/"]) assert.throws(() => approvedUrl(url, origins));
});
test("actual HTML SDK extracts visible body and excludes scripts/navigation; HTTP failures are bounded", async () => {
  // Run the copied application adapter from its SDK installation tree, independently of compiled test output.
  const url = pathToFileURL(join(process.cwd(), "examples/_shared/tools/retrieval/web.ts")).href;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const { readable, pageEvidence, download } = await import(${JSON.stringify(url)});
    const html = '<html><head><title>Evidence</title></head><body><nav><p>SQLite NAVIGATION must disappear despite enough characters.</p></nav><main><script>SQLite SECRET injected instructions</script><p>SQLite retention is 35 days &amp; backup copies are kept separately.</p></main></body></html>';
    const parsed = readable(html); assert.equal(parsed.title, 'Evidence'); assert.equal(parsed.blocks.length, 1); assert.ok(!JSON.stringify(parsed).includes('SECRET')); assert.ok(!JSON.stringify(parsed).includes('NAVIGATION'));
    const result = pageEvidence('https://www.sqlite.org/fts5.html', html, 'SQLite'); assert.equal(result.evidence.length, 1); assert.ok(result.evidence[0].text.includes('& backup'));
    for (const response of [new Response('bad', {status: 500}), new Response('{}', {headers:{'content-type':'application/json'}}), new Response('x'.repeat(4*1024*1024+1), {headers:{'content-type':'text/html'}})]) { globalThis.fetch = async()=>response; await assert.rejects(download(new URL('https://example.test'), 'html')); }
    globalThis.fetch = async(_url, options)=>{assert.equal(options.redirect,'error');options.signal.throwIfAborted();throw new Error('unavailable')}; await assert.rejects(download(new URL('https://example.test'), 'html', AbortSignal.abort()));
  `]);
});
test("Brave selection uses the existing application credential setting and never silently falls back", async () => {
  const s = await setup(), name = "DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY", previous = process.env[name];
  const adapters = new RetrievalAdapters(s.dir, { ...s.request, searchEngine: "brave" });
  try { delete process.env[name]; assert.throws(() => adapters.tools); process.env[name] = "unit-only-placeholder"; assert.ok(adapters.tools.some(t => t.name === "web_search")); }
  finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; adapters.close(); await s.close(); }
});

test("internal knowledge uses MEMORY.SEARCH and needs no external knowledge database", async () => {
  const s = await setup("knowledge-base", { knowledge: "internal" });
  try { assert.equal(s.adapters.db, undefined); await rm(join(s.dir, "knowledge.sqlite")); const report = await s.run() as Report; assert.equal(report.status, "completed"); assert.ok(report.evidence.every(e => e.source === "knowledge-internal" && e.uri.startsWith("memory:knowledge:team-a:"))); const saved = JSON.parse(await readFile(join(s.dir, "snapshots", report.evidence[0]!.snapshot, "memory.json"), "utf8")); assert.equal(saved.content.kind, "knowledge"); assert.ok(saved.content.text.includes(`${s.retentionDays} days`)); } finally { await s.close(); }
});
test("internal and external knowledge stay identifiable when queried together", async () => {
  const s = await setup("knowledge-base", { knowledge: "both" });
  try { const report = await s.run() as Report; assert.deepEqual([...new Set(report.evidence.map(e => e.source))].sort(), ["knowledge-external", "knowledge-internal"]); } finally { await s.close(); }
});
test("knowledge namespaces exclude other tenants and task checkpoints", async () => {
  const s = await setup("knowledge-base", { knowledge: "internal" });
  try {
    await importInternalKnowledge(s.runtime, "team-b", [{ key: "knowledge:team-b:retention", title: "Restricted", text: "Retention contains CONFIDENTIAL_TEAM_B knowledge only." }]);
    assert.throws(() => request({ ...s.request, internalKnowledgeKeys: ["knowledge:team-b:retention"] }));
    assert.throws(() => request({ ...s.request, internalKnowledgeKeys: [`retrieval:${s.request.id}:report`] }));
    const report = await s.run() as Report; assert.ok(!JSON.stringify(report).includes("CONFIDENTIAL_TEAM_B")); assert.ok(report.evidence.every(e => e.source === "knowledge-internal"));
    await assert.rejects(importInternalKnowledge(s.runtime, "team-a", [{ key: "knowledge:team-b:retention", title: "Wrong tenant", text: "Wrong tenant must be rejected." }]));
  } finally { await s.close(); }
});

test("request identity is stable across JSON property ordering and validated process reloads", async () => {
  const s = await setup("knowledge-base", { knowledge: "both" });
  try { const first = await s.run(); const reversed = request(Object.fromEntries(Object.entries(s.request).reverse())); assert.deepEqual(await runRetrieval(s.runtime, { request: reversed, model: { provider: "unit", model: "unit" } }), first); assert.equal(s.calls(), 2); } finally { await s.close(); }
});
