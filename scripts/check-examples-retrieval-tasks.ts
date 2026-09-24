import { limitCapabilityCases } from "./lib/capability-cases.ts";
/** Complete tasks against real model, Redis, SQLite FTS/Memory, files and public HTTP sources. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { contextScopeKey } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createRetrievalWorker } from "@ditto/core/worker/retrieval";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { importInternalKnowledge } from "../examples/_shared/tools/retrieval/memory.ts";
import { RetrievalAdapters } from "../examples/_shared/tools/retrieval/adapters.ts";
import { modes, digest, type Mode, type Report } from "../examples/_shared/tools/retrieval/domain.ts";
import { createFixture } from "../examples/capabilities/retrieval/fixtures.ts";
import { sandbox } from "../examples/capabilities/retrieval/cli.ts";
import { runRetrieval, collect, prepareContext, scope, memoryKey, type Options } from "../examples/capabilities/retrieval/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-retrieval-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-retrieval-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]); const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const scenarios: { name: string; mode: Mode }[] = [...modes.map(mode => ({ name: `${mode}-complete-task`, mode })),
  ...["redis-expiry", "redis-unavailable", "memory-unavailable", "knowledge-unavailable", "source-failure-retry", "publication-failure-retry", "invalid-citation", "invalid-query", "evidence-process-crash", "report-process-crash", "source-change-after-checkpoint", "request-change-rejected", "cancellation", "no-matches", "memory-report-write-failure"].map(name => ({ name, mode: name === "knowledge-unavailable" ? "knowledge-base" as const : "document-search" as const })), { name: "partial-multi-source", mode: "multi-source" }, ...["internal-knowledge", "both-knowledge", "internal-process-crash", "partial-external-knowledge"].map(name => ({ name, mode: "knowledge-base" as const }))];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const dir = join(directory, scenario.name); await mkdir(dir);
  const fixture = await createFixture(dir, scenario.mode, scenario.name === "internal-knowledge" || scenario.name === "internal-process-crash" ? { knowledge: "internal" } : scenario.name === "both-knowledge" ? { knowledge: "both" } : scenario.name === "partial-external-knowledge" ? { knowledge: "both", allowPartial: true } : scenario.name === "partial-multi-source" ? { allowPartial: true } : scenario.name === "no-matches" ? { query: `unfindable_${Date.now()}` } : {}), r = fixture.request;
  const spans: { node: string; input: unknown; original?: unknown }[] = [], children: { spans: string[]; modelCalls: number }[] = [];
  let corrupt: "citation" | "query" | undefined;
  function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
    const span: typeof spans[number] = { node, input }; spans.push(span); let value = await w.execute(node, input, context);
    if (node === "INFER.REASONING.SAMPLE") { span.original = value;
      if (corrupt) { const altered = structuredClone(value) as { output: { message: { content: string } } }; const content = altered.output.message.content;
        if (corrupt === "query" || content.includes('"findings"')) { altered.output.message.content = corrupt === "query" ? '{"queries":["forbidden_topic"]}' : '{"findings":[{"sourceId":"fabricated","quote":"Fabricated quote not in any source."}]}'; value = altered; }
      }
    }
    return value;
  }, async dispose() { await w.dispose?.(); } }; } }; }
  let adapters = new RetrievalAdapters(dir, r), storage = await openAgentStorage(dir, config);
  const open = () => createDitto({ config, sandbox: sandbox(config, r, adapters), workers: [...storage.workers, createInferWorker(), createRetrievalWorker({ providers: adapters.providers }), createInteractionWorker({ tools: adapters.tools })].map(observed) });
  let runtime = open();
  if (r.knowledge !== "external") {
    await importInternalKnowledge(runtime, r.tenant, fixture.internalKnowledge);
    await importInternalKnowledge(runtime, "team-b", [{ key: "knowledge:team-b:retention", title: "Restricted knowledge", text: "SQLite retention CONFIDENTIAL_TEAM_B may not enter team-a knowledge." }]);
  }
  const entry = await import(`../examples/capabilities/retrieval/${r.mode}.ts`) as { run: typeof runRetrieval };
  const run = (options: Options = {}): ReturnType<typeof runRetrieval> => entry.run(runtime, { request: r, model: { provider, model } }, options);
  const reopen = async () => { await runtime.close(); await storage.close(); adapters.close(); adapters = new RetrievalAdapters(dir, r); storage = await openAgentStorage(dir, config); runtime = open(); };
  const calls = () => spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () => assert.equal(await readFile(join(dir, "artifacts/brief.json")).then(() => true, () => false), false);
  async function child(phase: string) {
    await new Promise<void>((done, reject) => { const p = spawn(process.execPath, ["scripts/fixtures/retrieval-child.ts", "--directory", dir, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", chunk => { stderr += String(chunk); }); p.once("error", reject); p.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr || "Expected process crash")) : code === 0 ? done() : reject(new Error(stderr))); });
    children.push(JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")));
  }
  const record: Record<string, unknown> = { name: scenario.name, mode: scenario.mode, status: "failed", directory: dir };
  try {
    switch (scenario.name) {
      case "internal-knowledge": await rm(join(dir, "knowledge.sqlite")); assert.equal(adapters.db, undefined); break;
      case "internal-process-crash": await child("evidence-crash"); await absent(); await child("continue"); break;
      case "partial-external-knowledge": { const db = new DatabaseSync(join(dir, "knowledge.sqlite")); try { db.exec("ALTER TABLE articles RENAME TO missing_articles"); } finally { db.close(); } break; }
      case "rewrite-complete-task": assert.equal((await collect(runtime, r, [r.query])).evidence.length, 0); break;
      case "redis-expiry": { await run({ stopAfter: "evidence" }); const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null); await reopen(); const context = await prepareContext(runtime, r); assert.ok(context.items.some(i => i.id === "evidence")); break; }
      case "redis-unavailable": await storage.redis.quit(); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      case "memory-unavailable": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("ALTER TABLE memories RENAME TO missing_memories"); await assert.rejects(run(), /Worker failed/); assert.equal(calls(), 0); db.exec("ALTER TABLE missing_memories RENAME TO memories"); } finally { db.close(); } await reopen(); break; }
      case "knowledge-unavailable": { await run({ stopAfter: "queries" }); const db = new DatabaseSync(join(dir, "knowledge.sqlite")); try { db.exec("ALTER TABLE articles RENAME TO missing_articles"); await assert.rejects(run(), /Required retrieval failed/); await absent(); db.exec("ALTER TABLE missing_articles RENAME TO articles"); } finally { db.close(); } await reopen(); break; }
      case "source-failure-retry": { await run({ stopAfter: "queries" }); const original = await readFile(join(dir, "policy.md"), "utf8"); await rm(join(dir, "policy.md")); await assert.rejects(run(), /Required retrieval failed/); await absent(); await writeFile(join(dir, "policy.md"), original); await reopen(); break; }
      case "publication-failure-retry": await writeFile(join(dir, "artifacts"), "occupied"); await assert.rejects(run()); assert.equal(calls(), 2); await rm(join(dir, "artifacts")); await reopen(); break;
      case "invalid-citation": corrupt = "citation"; await assert.rejects(run(), /Unsupported citation/); await absent(); corrupt = undefined; break;
      case "invalid-query": corrupt = "query"; await assert.rejects(run(), /trusted search topic/); assert.equal(spans.filter(s => s.node === "RETRIEVAL.SEARCH").length, 0); await absent(); corrupt = undefined; break;
      case "evidence-process-crash": await child("evidence-crash"); await absent(); await child("continue"); break;
      case "report-process-crash": await child("report-crash"); await absent(); await child("continue"); break;
      case "source-change-after-checkpoint": await run({ stopAfter: "evidence" }); await writeFile(join(dir, "policy.md"), "Replaced source: should use archived evidence."); await reopen(); break;
      case "cancellation": await assert.rejects(run({ signal: AbortSignal.abort() })); assert.equal(calls(), 0); await absent(); break;
      case "partial-multi-source": await rm(join(dir, "policy.md")); break;
      case "memory-report-write-failure": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:report' BEGIN SELECT RAISE(ABORT,'unavailable'); END"); await assert.rejects(run(), /Worker failed/); await absent(); db.exec("DROP TRIGGER fail_report"); } finally { db.close(); } await reopen(); break; }
    }
    const result = await run() as Report;
    assert.equal(result.status, ["partial-multi-source", "partial-external-knowledge"].includes(scenario.name) ? "partial" : scenario.name === "no-matches" ? "no-evidence" : "completed");
    assert.equal(calls(), ["invalid-citation", "invalid-query", "memory-report-write-failure"].includes(scenario.name) ? 3 : scenario.name === "no-matches" ? 1 : 2);
    if (result.status !== "no-evidence") assert.ok(result.findings.length > 0);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "artifacts/brief.json"), "utf8")), result);
    const markdown = await readFile(join(dir, "artifacts/brief.md"), "utf8");
    assert.ok(!JSON.stringify(result).includes("CONFIDENTIAL_TEAM_B"));
    for (const finding of result.findings) {
      const e = result.evidence.find(e => e.id === finding.sourceId)!; assert.ok(e.text.includes(finding.quote)); assert.ok(markdown.includes(finding.quote)); assert.ok(markdown.includes(e.location));
      const path = join(dir, "snapshots", e.snapshot);
      if (e.source === "web") { const html = await readFile(join(path, "page.html"), "utf8"); assert.equal(digest(html), e.snapshot); const extracted = await readFile(join(path, "extracted.txt"), "utf8"); assert.ok(extracted.includes(finding.quote)); assert.match(e.uri, /^https:/); }
      else if (e.source === "documents") { const raw = await readFile(join(path, "document.md"), "utf8"); assert.equal(digest(raw), e.snapshot); const line = Number(/line (\d+)/.exec(e.location)![1]); assert.ok(raw.split(/\r?\n/)[line - 1]!.includes(finding.quote)); }
      else if (e.source === "knowledge-internal") { const raw = await readFile(join(path, "memory.json"), "utf8"), record = JSON.parse(raw); assert.equal(digest(raw), e.snapshot); assert.equal(record.content.tenant, r.tenant); assert.equal(record.content.kind, "knowledge"); assert.ok(record.content.text.includes(finding.quote)); }
      else { const row = JSON.parse(await readFile(join(path, "record.json"), "utf8")); assert.equal(digest(JSON.stringify(row)), e.snapshot); assert.equal(row.tenant, r.tenant); assert.ok(row.body.includes(finding.quote)); }
    }
    if (scenario.mode === "expand") { assert.ok(result.evidence.some(e => e.text.includes(`${fixture.retentionDays} days`))); assert.ok(result.evidence.some(e => e.text.includes(`${fixture.backupHours} hours`))); assert.ok(result.queries.length >= 2); }
    if (["document-search", "knowledge-base", "rewrite", "source-location"].includes(scenario.mode) && result.status !== "no-evidence") assert.ok(result.evidence.some(e => e.text.includes(`${fixture.retentionDays} days`)));
    if (scenario.mode === "multi-source") assert.deepEqual([...new Set(result.evidence.map(e => e.source))].sort(), scenario.name === "partial-multi-source" ? ["knowledge-external", "web"] : ["documents", "knowledge-external", "web"]);
    if (scenario.name === "request-change-rejected") await assert.rejects(runRetrieval(runtime, { model: { provider, model }, request: { ...r, question: "changed question" } }), /Request changed/);
    if (r.knowledge !== "external") {
      const allNodes = [...spans.map(s => s.node), ...children.flatMap(c => c.spans)]; assert.ok(allNodes.includes("MEMORY.SEARCH"));
      assert.ok(result.evidence.some(e => e.source === "knowledge-internal"));
      if (r.knowledge === "internal") { assert.ok(!allNodes.includes("RETRIEVAL.SEARCH")); assert.ok(result.evidence.every(e => e.source === "knowledge-internal")); }
      if (scenario.name === "both-knowledge") assert.ok(result.evidence.some(e => e.source === "knowledge-external"));
      if (scenario.name === "partial-external-knowledge") assert.deepEqual(result.failures, [{ source: "knowledge-external", code: "SOURCE_UNAVAILABLE" }]);
    }
    const used = calls(), searched = spans.filter(s => ["RETRIEVAL.SEARCH", "INTERACTION.ACT.TOOL"].includes(s.node)).length;
    await reopen(); assert.deepEqual(await run(), result); assert.equal(calls(), used);
    assert.equal(spans.filter(s => ["RETRIEVAL.SEARCH", "INTERACTION.ACT.TOOL"].includes(s.node)).length, searched + 1); // only idempotent local publication
    const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); assert.ok(await storage.redis.pTTL(key) > 0);
    assert.ok(JSON.parse((await storage.redis.get(key))!).context.items.some((i: { id: string }) => i.id === "report"));
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true }); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_key LIKE ?").get(`retrieval:${r.id}:%`)!.n, 4); assert.ok(db.prepare("SELECT content FROM memories WHERE memory_key=?").get(memoryKey(r, "report"))); } finally { db.close(); }
    record.result = result; record.storage = { context: "redis", memory: "sqlite", knowledge: "sqlite-fts5" }; record.status = "passed";
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally { await runtime.close(); await storage.close(); adapters.close(); Object.assign(record, { spans, children, modelCalls: calls() }); results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, searchEngine: "wikipedia", results }, null, 2)); console.log(JSON.stringify({ name: scenario.name, status: record.status, modelCalls: calls(), ...(record.error ? { error: record.error } : {}) })); }
}
const failed = results.filter(r => r.status !== "passed"); console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2)); if (failed.length) throw new Error(`${failed.length} retrieval tasks failed`);
