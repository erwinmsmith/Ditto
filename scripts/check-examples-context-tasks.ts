import { limitCapabilityCases } from "./lib/capability-cases.ts";
/** Real release handover tasks against Redis, database Memory and a configured model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile, graph } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { ContextError, contextScopeKey, createRedisContextStore } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { contextTools } from "../examples/_shared/tools/context/adapters.ts";
import { modes, type Mode } from "../examples/_shared/tools/context/domain.ts";
import { createFixture } from "../examples/capabilities/context/fixtures.ts";
import { sandbox } from "../examples/capabilities/context/cli.ts";
import { runContext, scope, memoryKey, seedConversation, type Options, type Report } from "../examples/capabilities/context/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-context-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-context-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider; assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const scenarios: { name: string; mode: Mode }[] = [
  ...modes.map(mode => ({ name: `${mode}-complete-task`, mode })), ...modes.map(mode => ({ name: `${mode}-cache-expiry`, mode })),
  ...["redis-unavailable", "memory-unavailable", "memory-write-retry", "publication-retry", "invalid-document-retry", "cancel-before-work", "changed-request", "scope-isolation", "cas-conflict"].map(name => ({ name, mode: "load" as const })),
  { name: "selection-budget", mode: "select" }, { name: "summary-evidence", mode: "compress" }, { name: "protected-budget", mode: "compress" },
  { name: "search-unavailable", mode: "assemble" }, { name: "compressed-process-crash", mode: "compress" }, { name: "updated-process-crash", mode: "update" }, { name: "report-process-crash", mode: "load" },
];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" })); const dir = join(directory, scenario.name); await mkdir(dir);
  const fixture = await createFixture(dir, scenario.mode), r = fixture.request;
  const spans: { node: string; input: unknown; original?: unknown }[] = [], children: { spans: string[]; modelCalls: number }[] = []; let corrupt = false;
  function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
    const span: typeof spans[number] = { node, input }; spans.push(span); let value = await w.execute(node, input, context);
    if (node === "INFER.REASONING.SAMPLE") { span.original = value; if (corrupt) { const altered = structuredClone(value) as { output: { message: { content: string } } }; altered.output.message.content = JSON.stringify({ owner: fixture.decisions.owner, budget: fixture.decisions.budget, evidence: [{ id: "history-0", quote: "fabricated" }, { id: "history-1", quote: "fabricated" }] }); value = altered; } }
    return value;
  }, async dispose() { await w.dispose?.(); } }; } }; }
  let storage = await openAgentStorage(dir, config);
  const open = () => createDitto({ config, sandbox: sandbox(config, r), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: contextTools(dir, r) })].map(observed) });
  let runtime = open(); await seedConversation(runtime, r, fixture.turns);
  const entry = await import(`../examples/capabilities/context/${r.mode}.ts`) as { run: typeof runContext };
  const run = (options: Options = {}): ReturnType<typeof runContext> => entry.run(runtime, { request: r, model: { provider, model } }, options);
  const reopen = async () => { await runtime.close(); await storage.close(); storage = await openAgentStorage(dir, config); runtime = open(); };
  const calls = () => spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + c.modelCalls, 0);
  const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r));
  const absent = async () => assert.equal(await readFile(join(dir, "artifacts/brief.json")).then(() => true, () => false), false);
  async function expire() { await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null); }
  async function child(phase: string) {
    await new Promise<void>((done, reject) => { const p = spawn(process.execPath, ["scripts/fixtures/context-child.ts", "--directory", dir, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", c => { stderr += String(c); }); p.once("error", reject); p.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr || "Expected process crash")) : code === 0 ? done() : reject(new Error(stderr))); }); children.push(JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")));
  }
  const record: Record<string, unknown> = { name: scenario.name, status: "failed", directory: dir };
  try {
    if (scenario.name.endsWith("cache-expiry")) { await run({ stopAfter: "ready" }); await expire(); await reopen(); }
    switch (scenario.name) {
      case "redis-unavailable": await storage.redis.quit(); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      case "memory-unavailable": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("ALTER TABLE memories RENAME TO missing_memories"); await assert.rejects(run()); assert.equal(calls(), 0); db.exec("ALTER TABLE missing_memories RENAME TO memories"); } finally { db.close(); } await reopen(); break; }
      case "memory-write-retry": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:report' BEGIN SELECT RAISE(ABORT,'unavailable'); END"); await assert.rejects(run()); await absent(); db.exec("DROP TRIGGER fail_report"); } finally { db.close(); } await reopen(); break; }
      case "publication-retry": await writeFile(join(dir, "artifacts"), "occupied"); await assert.rejects(run()); assert.equal(calls(), 1); await rm(join(dir, "artifacts")); await reopen(); break;
      case "invalid-document-retry": { const path = join(dir, "document.json"), bytes = await readFile(path); await writeFile(path, "{}"); await assert.rejects(run()); assert.equal(calls(), 0); await absent(); await writeFile(path, bytes); break; }
      case "cancel-before-work": await assert.rejects(run({ signal: AbortSignal.abort() })); assert.equal(calls(), 0); await absent(); break;
      case "changed-request": await run({ stopAfter: "base" }); await assert.rejects(runContext(runtime, { request: { ...r, goal: "Replace the approved request" }, model: { provider, model } }), /Request changed/); assert.equal(calls(), 0); break;
      case "scope-isolation": { await run({ stopAfter: "base" }); const other = graph("other-scope").node("result", "CONTEXT.LOAD", [], () => ({ scope: scope({ ...r, tenant: "team-b" }) })); await assert.rejects(runtime.run(other, {}), (error: unknown) => error instanceof ContextError && error.code === "CONTEXT_NOT_FOUND"); break; }
      case "cas-conflict": {
        await run({ stopAfter: "base" }); const store = createRedisContextStore(storage.redis, config.context.cache), snapshot = await store.get(scope(r)); assert.ok(snapshot);
        const change = graph<{ version?: string }>("context-cas").node("result", "CONTEXT.UPDATE", [], i => ({ scope: scope(r), add: [{ id: "observation", content: "new" }], ...(i.version ? { expectedVersion: i.version } : {}) }));
        await runtime.run(change, {}); await assert.rejects(runtime.run(change, { version: snapshot.version }), /version|conflict/i); break;
      }
      case "selection-budget": await assert.rejects(run({ selectionLimit: 1 }), /mandatory/); assert.equal(calls(), 0); await absent(); break;
      case "summary-evidence": corrupt = true; await assert.rejects(run(), /unsupported evidence/); await absent(); corrupt = false; break;
      case "protected-budget": await assert.rejects(run({ compressionMaxItems: 3 }), /budget/i); await absent(); break;
      case "search-unavailable": { const path = join(dir, "search.json"), bytes = await readFile(path); await rm(path); await assert.rejects(run()); assert.equal(calls(), 0); await absent(); await writeFile(path, bytes); break; }
      case "compressed-process-crash": case "updated-process-crash": await child("ready-crash"); await absent(); await expire(); await child("continue"); break;
      case "report-process-crash": await child("report-crash"); await absent(); await expire(); await child("continue"); break;
    }
    const report = await run() as Report;
    const expected = { ...(scenario.mode === "update" ? fixture.revised : fixture.initial), ...(scenario.mode === "assemble" ? { region: "us-east" } : {}), ...fixture.decisions };
    for (const [k, v] of Object.entries(expected)) assert.equal((report.brief as unknown as Record<string, unknown>)[k], v);
    const normalCalls = ["compress", "update"].includes(scenario.mode) ? 2 : 1;
    assert.equal(calls(), normalCalls + (["summary-evidence", "protected-budget", "memory-write-retry"].includes(scenario.name) ? 1 : 0));
    if (scenario.mode === "select") { assert.equal(report.inputIds.length, 5); assert.equal(report.cachedIds.length, 23); assert.ok(!report.inputIds.includes("history-2")); }
    if (scenario.mode === "compress") { assert.deepEqual(report.cachedIds, ["instructions", "goal", "document", "summary"]); assert.ok(!report.inputIds.includes("history-0")); }
    if (scenario.mode === "update") { assert.equal(report.previous!.rolloutPercent, fixture.initial.rolloutPercent); assert.equal(report.previous!.region, fixture.initial.region); }
    const inferInputs = spans.filter(s => s.node === "INFER.REASONING.SAMPLE").map(s => JSON.stringify(s.input));
    if (scenario.mode === "select") assert.ok(inferInputs.every(i => !i.includes("cafeteria")));
    if (scenario.mode === "compress" && inferInputs.length) assert.ok(!inferInputs.at(-1)!.includes("cafeteria"));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "artifacts/brief.json"), "utf8")), report);
    const before = calls(); await expire(); await reopen(); assert.deepEqual(await run(), report); assert.equal(calls(), before);
    assert.ok(await storage.redis.pTTL(key) > 0);
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true }); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_key LIKE ?").get(`context:${r.tenant}:${r.id}:%`)!.n, 3); assert.ok(db.prepare("SELECT content FROM memories WHERE memory_key=?").get(memoryKey(r, "ready"))); } finally { db.close(); }
    const allNodes = [...spans.map(s => s.node), ...children.flatMap(c => c.spans)]; for (const n of ["MEMORY.GET", "MEMORY.WRITE", "CONTEXT.LOAD", "INFER.REASONING.SAMPLE", "INTERACTION.ACT.TOOL"]) assert.ok(allNodes.includes(n));
    if (scenario.mode === "select") assert.ok(allNodes.includes("CONTEXT.SELECT")); if (scenario.mode === "compress") assert.ok(allNodes.includes("CONTEXT.COMPRESS"));
    record.status = "passed"; record.brief = report.brief; record.storage = { context: "redis", memory: "sqlite" };
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally { await runtime.close(); await storage.close(); await fixture.server.close(); Object.assign(record, { spans, children, modelCalls: calls() }); results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, searchSource: "controlled HTTP search fixture, not public internet", results }, null, 2)); console.log(JSON.stringify({ name: scenario.name, status: record.status, modelCalls: calls(), ...(record.error ? { error: record.error } : {}) })); }
}
const failed = results.filter(r => r.status !== "passed"); console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2)); if (failed.length) throw new Error(`${failed.length} context task experiments failed`);
