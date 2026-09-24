import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker, createInMemoryContextStore } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openSqliteMemory } from "../examples/_shared/tools/storage/sqlite-memory.ts";
import { AnalysisAdapters } from "../examples/_shared/tools/analysis/adapters.ts";
import { compileReport, request, modes, type Request, type Material, type Report, type Mode, type Field } from "../examples/_shared/tools/analysis/domain.ts";
import { runAnalysis, prepareContext } from "../examples/capabilities/analysis/shared.ts";
const base: Request = { id: "unit-analysis", tenant: "team-a", mode: "compare", question: "Compare service specifications", period: "2026-Q3", subjects: ["Atlas", "Boreal"], allowedOrigins: [], sources: [{ id: "reference", format: "text", origin: "document", authority: "reference", period: "2026-Q3", locator: "reference.txt" }, { id: "claims", format: "text", origin: "document", authority: "claim", period: "2026-Q3", locator: "claims.txt" }, { id: "history", format: "text", origin: "document", authority: "reference", period: "2026-Q2", locator: "history.txt" }] };
const inputTexts = { reference: "Atlas retention is 21 days.\nAtlas storage capacity is 1000 GB.\nBoreal retention is 14 days.\nBoreal storage capacity is 500 GB.", claims: "Atlas retention is 4 weeks.\nAtlas storage capacity is 1 TB.\nBoreal support response is 24 hours.", history: "Atlas retention is 7 days." };
const material: Material = { sources: base.sources.map(s => ({ id: s.id, snapshot: s.id, engine: "unit data", uri: s.locator })), blocks: Object.entries(inputTexts).flatMap(([sourceId, body]) => body.split("\n").map((text, index) => ({ id: `${sourceId}-${index + 1}`, sourceId, text, location: `line ${index + 1}`, snapshot: sourceId }))) };
function proposal(m: Material) {
  return { claims: m.blocks.map(b => { const match = /^(Atlas|Boreal) (retention|storage capacity|support response) is (\d+) (days|weeks|GB|TB|hours)\.$/.exec(b.text)!; const field: Field = match[2] === "retention" ? "retention_days" : match[2] === "storage capacity" ? "storage_gb" : "support_hours"; return { blockId: b.id, subject: match[1]!, field, value: Number(match[3]), unit: match[4]!, quote: b.text }; }), unresolved: [] as { blockId: string; reason: string }[] };
}
test("normalization deduplicates equivalent units and retains distinct sources and original quotations", () => {
  const report = compileReport(base, material, proposal(material)); const capacity = report.groups.find(g => g.subject === "Atlas" && g.field === "storage_gb")!;
  assert.equal(capacity.value, 1000); assert.equal(capacity.claims.length, 2); assert.deepEqual(capacity.sources, ["reference", "claims"]); assert.equal(report.groups.length, 7); assert.ok(report.claims.some(c => c.quote.includes("1 TB")));
});
test("conflicts are scoped to object, field and period; duplicates do not become contradictions", () => {
  const report = compileReport(base, material, proposal(material)); assert.equal(report.conflicts.length, 1); assert.equal(report.conflicts[0]!.field, "retention_days"); assert.equal(report.conflicts[0]!.period, "2026-Q3"); assert.equal(report.groups.find(g => g.value === 28)!.verification, "refuted"); assert.equal(report.groups.find(g => g.field === "support_hours")!.verification, "unverified");
});
test("conflicting references remain disputed and cannot produce a numeric comparison", () => {
  const r = structuredClone(base); r.sources[1]!.authority = "reference"; const report = compileReport(r, material, proposal(material)); assert.ok(report.groups.filter(g => g.subject === "Atlas" && g.field === "retention_days" && g.period === r.period).every(g => g.verification === "disputed")); assert.equal(report.differences.find(d => d.field === "retention_days")!.delta, null);
});
test("reference absence remains unverified, regardless of agreement or repeated copies", () => {
  const r = structuredClone(base); r.sources.forEach(s => { s.authority = "claim"; }); const report = compileReport(r, material, proposal(material)); assert.ok(report.groups.every(g => g.verification === "unverified")); assert.ok(report.comparison.every(c => c.value === null));
});
test("comparison uses only supported current-period facts and computes explicit right-minus-left deltas", () => {
  const report = compileReport(base, material, proposal(material)); assert.deepEqual(report.differences.map(d => d.delta), [-7, -500, null]); assert.equal(report.comparison.find(c => c.subject === "Atlas" && c.field === "retention_days")!.value, 21);
});
test("model fields cannot change controller-owned authority, origin or period", () => {
  const p = proposal(material); const forged = { ...p, claims: p.claims.map(c => ({ ...c, authority: "reference", origin: "knowledge-internal", period: "2026-Q2" })) }; const report = compileReport(base, material, forged); assert.equal(report.groups.find(g => g.value === 28)!.verification, "refuted"); assert.ok(report.claims.every(c => c.origin === "document"));
});
test("unknown fields, forged quotes, mismatched units/subjects and missing or duplicate coverage are rejected", () => {
  for (const change of [{ quote: "Atlas retention is 999 days." }, { value: 999 }, { field: "storage_gb" }, { subject: "Boreal" }, { unit: "__proto__" }, { field: "__proto__" }, { value: -21 }, { blockId: "unknown" }]) {
    const p = proposal(material); Object.assign(p.claims[0]!, change); assert.throws(() => compileReport(base, material, p));
  }
  const missing = proposal(material); missing.claims.pop(); assert.throws(() => compileReport(base, material, missing), /omitted/);
  const duplicate = proposal(material); duplicate.claims.push(duplicate.claims[0]!); assert.throws(() => compileReport(base, material, duplicate), /duplicate/);
});
test("unresolved source blocks are retained explicitly and cannot silently disappear", () => {
  const p = proposal(material), omitted = p.claims.pop()!; p.unresolved.push({ blockId: omitted.blockId, reason: "Cannot resolve this input reliably" }); const report = compileReport(base, material, p); assert.equal(report.unresolved.length, 1); assert.equal(report.claims.length, material.blocks.length - 1);
});
test("request validation rejects cross-tenant Memory keys, traversal, unapproved origins and origin spoofing", () => {
  for (const source of [{ ...base.sources[0]!, locator: "../secret.txt" }, { ...base.sources[0]!, format: "memory", origin: "knowledge-internal", locator: "knowledge:team-b:secret" }, { ...base.sources[0]!, format: "web", origin: "web", locator: "http://example.com/" }, { ...base.sources[0]!, origin: "knowledge-internal" }]) assert.throws(() => request({ ...base, sources: [source] }));
});
async function setup(mode: Mode = "compare") {
  const directory = await mkdtemp(join(tmpdir(), "ditto-analysis-unit-")), r = { ...base, mode }; for (const [name, body] of Object.entries(inputTexts)) await writeFile(join(directory, `${name}.txt`), body);
  const adapters = new AnalysisAdapters(directory, r, "unused"), memory = openSqliteMemory(join(directory, "memory.sqlite")); let calls = 0;
  const open = () => createDitto({ sandbox: { tools: adapters.tools.map(t => t.name) }, workers: [createContextWorker({ services: { stateStore: createInMemoryContextStore() } }), createMemoryWorker({ store: memory.store }), createInteractionWorker({ tools: adapters.tools }), createInferWorker({ providers: { unit: { async invoke(input) { calls++; const items = JSON.parse(String(input.messages[1]!.content)) as { id: string; content: { value: Material } }[]; const m = items.find(i => i.id === "sources")!.content.value; return { message: { role: "assistant", content: JSON.stringify(proposal(m)) }, finishReason: "stop" }; } } } })] });
  let runtime = open(); const run = () => runAnalysis(runtime, { request: r, model: { provider: "unit", model: "unit" } });
  return { directory, request: r, get runtime() { return runtime; }, run, calls: () => calls, async reopen() { await runtime.close(); runtime = open(); }, async close() { await runtime.close(); await memory.close(); adapters.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("seven analysis modes execute through Runtime and persist real report files and database Memory with explicit unit model/Context", async () => {
  for (const mode of modes) { const s = await setup(mode); try { const report = await s.run() as Report; assert.equal(report.focus, mode); assert.equal(s.calls(), 1); assert.deepEqual(JSON.parse(await readFile(join(s.directory, "artifacts/analysis.json"), "utf8")), report); assert.ok((await readFile(join(s.directory, "artifacts/facts.csv"), "utf8")).includes('"refuted"')); } finally { await s.close(); } }
});
test("a new Context cache restores archived sources/report from database Memory without repeating inference", async () => {
  const s = await setup(); try { const first = await s.run(); await s.reopen(); assert.ok((await prepareContext(s.runtime, s.request)).items.some(i => i.id === "report")); assert.deepEqual(await s.run(), first); assert.equal(s.calls(), 1); } finally { await s.close(); }
});
test("publication failure retries existing reports without another model call", async () => {
  const s = await setup(); try { await writeFile(join(s.directory, "artifacts"), "occupied"); await assert.rejects(s.run()); assert.equal(s.calls(), 1); await rm(join(s.directory, "artifacts")); await s.reopen(); await s.run(); assert.equal(s.calls(), 1); } finally { await s.close(); }
});
test("failed sources Memory commit prevents inference until persistence is repaired", async () => {
  const s = await setup(), db = new DatabaseSync(join(s.directory, "memory.sqlite")); try { db.exec("CREATE TRIGGER fail_sources BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:sources' BEGIN SELECT RAISE(ABORT,'unavailable'); END"); await assert.rejects(s.run()); assert.equal(s.calls(), 0); db.exec("DROP TRIGGER fail_sources"); await s.run(); assert.equal(s.calls(), 1); } finally { db.close(); await s.close(); }
});
test("request identity survives JSON reordering but rejects changed trust policy", async () => {
  const s = await setup(); try { const first = await s.run(); assert.deepEqual(await runAnalysis(s.runtime, { request: request(Object.fromEntries(Object.entries(s.request).reverse())), model: { provider: "unit", model: "unit" } }), first); const changed = structuredClone(s.request); changed.sources[0]!.authority = "claim"; await assert.rejects(runAnalysis(s.runtime, { request: changed, model: { provider: "unit", model: "unit" } }), /Request changed/); } finally { await s.close(); }
});
