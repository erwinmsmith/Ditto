import { limitCapabilityCases } from "./lib/capability-cases.ts";
/** Real task acceptance: physical files, HTTP pages, actual models, Redis, Memory and deliverables. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { contextScopeKey } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { importInternalKnowledge } from "../examples/_shared/tools/retrieval/memory.ts";
import { AnalysisAdapters } from "../examples/_shared/tools/analysis/adapters.ts";
import { modes, digest, type Report, type Mode } from "../examples/_shared/tools/analysis/domain.ts";
import { createFixture, pythonPath } from "../examples/capabilities/analysis/fixtures.ts";
import { sandbox } from "../examples/capabilities/analysis/cli.ts";
import { runAnalysis, prepareContext, scope, memoryKey, type Options } from "../examples/capabilities/analysis/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-analysis-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-analysis-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider; assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const scenarios: { name: string; mode: Mode }[] = [...modes.map(mode => ({ name: `${mode}-complete-task`, mode })), ...["reference-conflict", "no-reliable-reference", "invalid-citation", "missing-block", "trust-spoof", "redis-expiry", "redis-unavailable", "memory-unavailable", "invalid-pdf-retry", "external-unavailable", "missing-internal-knowledge", "sources-process-crash", "report-process-crash", "publication-retry", "report-memory-write-retry", "source-change-after-checkpoint", "cancel-before-work"].map(name => ({ name, mode: "fact-check" as const }))];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" })); const dir = join(directory, scenario.name); await mkdir(dir);
  const fixture = await createFixture(dir, scenario.mode), r = fixture.request;
  if (scenario.name === "no-reliable-reference") r.sources.forEach(s => { s.authority = "claim"; });
  if (scenario.name === "reference-conflict") { const db = new DatabaseSync(join(dir, "knowledge.sqlite")); try { db.prepare("UPDATE documents SET body=? WHERE tenant='team-a'").run(`Boreal storage capacity is ${fixture.expected.storage + 100} GB under the approved service specification.`); } finally { db.close(); } }
  await writeFile(join(dir, "request.json"), JSON.stringify(r));
  const spans: { node: string; input: unknown; original?: unknown }[] = [], children: { spans: string[]; modelCalls: number }[] = [];
  let corrupt: "citation" | "omit" | "trust" | undefined;
  function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
    const span: typeof spans[number] = { node, input }; spans.push(span); let value = await w.execute(node, input, context);
    if (node === "INFER.REASONING.SAMPLE") { span.original = value;
      if (corrupt) { const altered = structuredClone(value) as { output: { message: { content: string } } }, proposal = JSON.parse(altered.output.message.content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
        if (corrupt === "citation") proposal.claims[0].quote = "Atlas retention is 999 days. Fabricated evidence.";
        if (corrupt === "omit") proposal.claims.pop();
        if (corrupt === "trust") for (const c of proposal.claims) c.authority = "reference";
        altered.output.message.content = JSON.stringify(proposal); value = altered;
      }
    }
    return value;
  }, async dispose() { await w.dispose?.(); } }; } }; }
  let adapters = new AnalysisAdapters(dir, r, pythonPath()), storage = await openAgentStorage(dir, config);
  const open = () => createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools })].map(observed) });
  let runtime = open(); await importInternalKnowledge(runtime, r.tenant, fixture.knowledge);
  const entry = await import(`../examples/capabilities/analysis/${r.mode}.ts`) as { run: typeof runAnalysis };
  const run = (options: Options = {}): ReturnType<typeof runAnalysis> => entry.run(runtime, { request: r, model: { provider, model } }, options);
  const reopen = async () => { await runtime.close(); await storage.close(); adapters.close(); adapters = new AnalysisAdapters(dir, r, pythonPath()); storage = await openAgentStorage(dir, config); runtime = open(); };
  const calls = () => spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () => assert.equal(await readFile(join(dir, "artifacts/analysis.json")).then(() => true, () => false), false);
  async function child(phase: string) {
    await new Promise<void>((done, reject) => { const p = spawn(process.execPath, ["scripts/fixtures/analysis-child.ts", "--directory", dir, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", c => { stderr += String(c); }); p.once("error", reject); p.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr || "Expected process crash")) : code === 0 ? done() : reject(new Error(stderr))); }); children.push(JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")));
  }
  const record: Record<string, unknown> = { name: scenario.name, status: "failed", directory: dir };
  try {
    switch (scenario.name) {
      case "invalid-citation": corrupt = "citation"; await assert.rejects(run()); await absent(); corrupt = undefined; break;
      case "missing-block": corrupt = "omit"; await assert.rejects(run()); await absent(); corrupt = undefined; break;
      case "trust-spoof": corrupt = "trust"; break;
      case "redis-expiry": { await run({ stopAfter: "sources" }); const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null); await reopen(); assert.ok((await prepareContext(runtime, r)).items.some(i => i.id === "sources")); break; }
      case "redis-unavailable": await storage.redis.quit(); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      case "memory-unavailable": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("ALTER TABLE memories RENAME TO missing_memories"); await assert.rejects(run()); assert.equal(calls(), 0); db.exec("ALTER TABLE missing_memories RENAME TO memories"); } finally { db.close(); } await reopen(); break; }
      case "invalid-pdf-retry": { const path = join(dir, "reference.pdf"), bytes = await readFile(path); await writeFile(path, "Not a PDF"); await assert.rejects(run()); assert.equal(calls(), 0); await absent(); await writeFile(path, bytes); break; }
      case "external-unavailable": { const db = new DatabaseSync(join(dir, "knowledge.sqlite")); try { db.exec("ALTER TABLE documents RENAME TO missing_documents"); await assert.rejects(run()); assert.equal(calls(), 0); await absent(); db.exec("ALTER TABLE missing_documents RENAME TO documents"); } finally { db.close(); } break; }
      case "missing-internal-knowledge": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.prepare("DELETE FROM memories WHERE memory_key=?").run(fixture.knowledge[0]!.key); await assert.rejects(run()); assert.equal(calls(), 0); await absent(); } finally { db.close(); } await importInternalKnowledge(runtime, r.tenant, fixture.knowledge); break; }
      case "sources-process-crash": await child("sources-crash"); await absent(); await child("continue"); break;
      case "report-process-crash": await child("report-crash"); await absent(); await child("continue"); break;
      case "publication-retry": await writeFile(join(dir, "artifacts"), "occupied"); await assert.rejects(run()); assert.equal(calls(), 1); await rm(join(dir, "artifacts")); await reopen(); break;
      case "report-memory-write-retry": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:report' BEGIN SELECT RAISE(ABORT,'unavailable'); END"); await assert.rejects(run()); await absent(); db.exec("DROP TRIGGER fail_report"); } finally { db.close(); } await reopen(); break; }
      case "source-change-after-checkpoint": await run({ stopAfter: "sources" }); await writeFile(join(dir, "notes.txt"), "Atlas retention is 999 days."); await reopen(); break;
      case "cancel-before-work": await assert.rejects(run({ signal: AbortSignal.abort() })); assert.equal(calls(), 0); await absent(); break;
    }
    const report = await run() as Report;
    assert.equal(calls(), ["invalid-citation", "missing-block", "report-memory-write-retry"].includes(scenario.name) ? 2 : 1);
    assert.equal(report.claims.length, 24); assert.equal(report.unresolved.length, 0); assert.equal(report.material.sources.length, 10);
    assert.equal(report.groups.length, scenario.name === "reference-conflict" ? 8 : 7); assert.equal(report.duplicates.length, 4);
    assert.equal(report.conflicts.length, scenario.name === "reference-conflict" ? 2 : 1);
    assert.ok(report.conflicts.every(c => c.period === r.period));
    const disputed = scenario.name === "reference-conflict", noReference = scenario.name === "no-reliable-reference";
    const bad = report.groups.find(g => g.subject === "Atlas" && g.period === r.period && g.field === "retention_days" && g.value === fixture.expected.conflictingRetention)!;
    assert.equal(bad.verification, noReference ? "unverified" : "refuted");
    assert.equal(report.groups.find(g => g.field === "support_hours")!.verification, "unverified");
    const retention = report.differences.find(d => d.field === "retention_days")!, capacity = report.differences.find(d => d.field === "storage_gb")!;
    assert.equal(retention.delta, noReference ? null : 14 - fixture.expected.retention); assert.equal(capacity.delta, noReference || disputed ? null : fixture.expected.storage - 1000);
    if (disputed) assert.equal(report.comparison.find(v => v.subject === "Boreal" && v.field === "storage_gb")!.status, "disputed");
    if (noReference) assert.ok(report.groups.every(g => g.verification === "unverified"));
    assert.ok(report.claims.some(c => c.origin === "knowledge-internal")); assert.ok(report.claims.some(c => c.origin === "knowledge-external")); assert.ok(!JSON.stringify(report).includes("CONFIDENTIAL_TEAM_B"));
    for (const source of report.material.sources) assert.equal(digest(await readFile(join(dir, "snapshots", source.snapshot, "source.bin"))), source.snapshot);
    for (const c of report.claims) { const b = report.material.blocks.find(b => b.id === c.blockId)!; assert.ok(b.text.includes(c.quote)); const saved = JSON.parse(await readFile(join(dir, "snapshots", b.snapshot, `${b.sourceId}-extracted.json`), "utf8")); assert.ok(saved.some((v: { id: string; text: string }) => v.id === b.id && v.text === b.text)); }
    assert.ok(report.material.blocks.some(b => b.sourceId === "reference" && b.location.startsWith("page 2")));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "artifacts/analysis.json"), "utf8")), report);
    const parsedCsv = JSON.parse((await promisify(execFile)(pythonPath(), ["-c", "import csv,json,sys; print(json.dumps(list(csv.DictReader(open(sys.argv[1])))))", join(dir, "artifacts/facts.csv")])).stdout) as Record<string, string>[];
    assert.equal(parsedCsv.length, report.groups.length); for (const g of report.groups) assert.ok(parsedCsv.some(row => row.subject === g.subject && row.field === g.field && row.period === g.period && Number(row.value) === g.value && row.verification === g.verification));
    const allNodes = [...spans.map(s => s.node), ...children.flatMap(c => c.spans)]; for (const n of ["MEMORY.SEARCH", "RETRIEVAL.SEARCH", "MEMORY.WRITE", "CONTEXT.LOAD"]) assert.ok(allNodes.includes(n));
    const before = calls(); await reopen(); assert.deepEqual(await run(), report); assert.equal(calls(), before);
    const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); assert.ok(await storage.redis.pTTL(key) > 0);
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true }); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_key LIKE ?").get(`analysis:${r.id}:%`)!.n, 3); assert.ok(db.prepare("SELECT content FROM memories WHERE memory_key=?").get(memoryKey(r, "report"))); } finally { db.close(); }
    record.status = "passed"; record.summary = { claims: report.claims.length, groups: report.groups.length, conflicts: report.conflicts.length, referenceConflict: disputed }; record.storage = { context: "redis", memory: "sqlite", externalKnowledge: "sqlite" };
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally { await runtime.close(); await storage.close(); adapters.close(); await fixture.server.close(); Object.assign(record, { spans, children, modelCalls: calls() }); results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, webSource: "controlled HTTP fixture, not public internet", results }, null, 2)); console.log(JSON.stringify({ name: scenario.name, status: record.status, modelCalls: calls(), ...(record.error ? { error: record.error } : {}) })); }
}
const failed = results.filter(r => r.status !== "passed"); console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2)); if (failed.length) throw new Error(`${failed.length} analysis task experiments failed`);
