import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, graph, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createHttpEmbeddingProvider, embeddingConfigFromEnv, type EmbeddingProvider } from "@codesoul-co/ditto-retrieval";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openMemoryStorage } from "../examples/_shared/tools/memory/storage.ts";
import { memoryTools } from "../examples/_shared/tools/memory/adapters.ts";
import { modes, backends, namespace, preferenceKey, taskKey, type Backend, type Mode, type Report } from "../examples/_shared/tools/memory/domain.ts";
import { createFixture } from "../examples/capabilities/memory/fixtures.ts";
import { sandbox } from "../examples/capabilities/memory/cli.ts";
import { runMemory, writeMemories, getMemories, recall, scope, nodeValue, type Options } from "../examples/capabilities/memory/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, backend: { type: "string" }, report: { type: "string", default: ".examples-memory-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-memory-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider; assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const selected = values.backend ? [values.backend as Backend] : backends; assert.ok(selected.every(b => backends.includes(b)));
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const scenarios: { name: string; mode: Mode }[] = [...modes.map(mode => ({ name: `${mode}-complete`, mode })),
  { name: "cache-expiry", mode: "task-state" }, { name: "redis-unavailable", mode: "search" }, { name: "database-unavailable", mode: "search" },
  { name: "missing-memory", mode: "search" }, { name: "save-not-approved", mode: "write" }, { name: "invalid-proposal", mode: "write" },
  { name: "publication-retry", mode: "search" }, { name: "write-process-crash", mode: "write" }, { name: "update-process-crash", mode: "update" },
  { name: "progress-process-crash", mode: "task-state" }, { name: "report-process-crash", mode: "search" },
  { name: "scope-and-pagination", mode: "search" }, { name: "changed-request", mode: "task-state" }, { name: "cancel-before-work", mode: "search" }];
limitCapabilityCases(scenarios);
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const backend of selected) for (const scenario of [...scenarios, ...(backend === "qdrant" ? [{ name: "embedding-dimension", mode: "search" as const }, { name: "embedding-identity", mode: "search" as const }] : [])]) {
  console.log(JSON.stringify({ backend, name: scenario.name, event: "started" }));
  const dir = join(directory, `${backend}-${scenario.name}`); await mkdir(dir); const fixture = await createFixture(dir, scenario.mode, backend), r = fixture.request;
  let unavailable = false; const qdrantUrl = process.env.DITTO_WORKER_MEMORY_QDRANT_URL; let proxy: ReturnType<typeof createServer> | undefined;
  if (backend === "qdrant" && scenario.name === "database-unavailable") {
    proxy = createServer(async (req, res) => { if (unavailable) { res.writeHead(503).end(); return; } try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const upstream = await fetch(qdrantUrl! + req.url, { method: req.method!, headers: { "content-type": "application/json", ...(process.env.DITTO_WORKER_MEMORY_QDRANT_API_KEY ? { "api-key": process.env.DITTO_WORKER_MEMORY_QDRANT_API_KEY } : {}) }, ...(req.method === "GET" ? {} : { body: Buffer.concat(chunks) }) }); res.writeHead(upstream.status, { "content-type": "application/json" }); res.end(await upstream.text()); } catch { res.writeHead(502).end(); } });
    await new Promise<void>(done => proxy!.listen(0, "127.0.0.1", done)); const address = proxy.address(); assert.ok(address && typeof address !== "string"); process.env.DITTO_WORKER_MEMORY_QDRANT_URL = `http://127.0.0.1:${address.port}`;
  }
  const spans: { node: string; input: unknown; original?: unknown }[] = [], children: { spans: string[]; modelCalls: number; embeddingCalls?: number; vectorQueries?: number }[] = []; let corrupt = false, embeddings = 0, searches = 0;
  function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
    const span: typeof spans[number] = { node, input }; spans.push(span); let result = await w.execute(node, input, context);
    if (node === "INFER.REASONING.SAMPLE") { span.original = result; if (corrupt) { const value = structuredClone(result) as { output: { message: { content: string } } }; value.output.message.content = '{"language":"Chinese","style":"concise","quote":"invented"}'; result = value; } }
    return result;
  }, async dispose() { await w.dispose?.(); } }; } }; }
  let storage = await openMemoryStorage({ directory: dir, backend, namespace: namespace(r), config });
  const open = () => createDitto({ config, sandbox: sandbox(config), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: memoryTools(dir, namespace(r)) })].map(observed) });
  let runtime = open(); await writeMemories(runtime, fixture.memories);
  const captureStats = () => { if (storage.database.stats) { embeddings += storage.database.stats.embeddingCalls; searches += storage.database.stats.vectorQueries; } };
  const reopen = async (embedding?: EmbeddingProvider) => { captureStats(); await runtime.close(); await storage.close(); storage = await openMemoryStorage({ directory: dir, backend, namespace: namespace(r), config, ...(embedding ? { embedding } : {}) }); runtime = open(); };
  const entry = await import(`../examples/capabilities/memory/${r.mode}.ts`) as { run: typeof runMemory };
  const run = (options: Options = {}): ReturnType<typeof runMemory> => entry.run(runtime, { request: r, model: { provider, model } }, options);
  const calls = () => spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () => assert.equal(await readFile(join(dir, "artifacts", `${r.id}.json`)).then(() => true, () => false), false);
  async function expire() { const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null); }
  async function child(phase: string) { await new Promise<void>((done, reject) => {
    const p = spawn(process.execPath, ["scripts/fixtures/memory-child.ts", "--directory", dir, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", c => { stderr += String(c); }); p.once("error", reject); p.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr || "Expected process crash")) : code === 0 ? done() : reject(new Error(stderr)));
  }); children.push(JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8"))); }
  async function vector() {
    if (!storage.database.client) return undefined;
    const found = (await getMemories(runtime, [preferenceKey(r)]))[0]; if (!found) return undefined;
    const data = await storage.database.client.request<{ vector: { text: number[] } }[]>(`/collections/${process.env.DITTO_WORKER_MEMORY_QDRANT_COLLECTION ?? "agent_memories"}/points`, "POST", { ids: [found.id], with_payload: false, with_vector: true }); return data[0]!.vector.text;
  }
  const beforeVector = scenario.mode === "update" ? await vector() : undefined;
  const record: Record<string, unknown> = { backend, name: scenario.name, status: "failed", directory: dir };
  try {
    switch (scenario.name) {
      case "cache-expiry": await run({ stopAfter: "progress" }); await expire(); await writeFile(join(dir, "project.json"), "invalid source after committed progress"); await reopen(); break;
      case "redis-unavailable": await storage.redis.quit(); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      case "database-unavailable": {
        if (backend === "sqlite") { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("ALTER TABLE memories RENAME TO unavailable_memories"); await assert.rejects(run()); assert.equal(calls(), 0); db.exec("ALTER TABLE unavailable_memories RENAME TO memories"); } finally { db.close(); } }
        if (backend === "postgres") {
          const require = createRequire(new URL("../examples/_shared/tools/storage/dependencies/package.json", import.meta.url)); const { Client } = require("pg") as { Client: new (options: object) => { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> } }; const db = new Client({ connectionString: process.env.DITTO_WORKER_MEMORY_POSTGRES_URL }); await db.connect(); const table = process.env.DITTO_WORKER_MEMORY_POSTGRES_TABLE ?? "agent_memories"; assert.match(table, /^[a-z][a-z0-9_]*$/);
          try { await db.query(`ALTER TABLE ${table} RENAME TO unavailable_memories`); try { await assert.rejects(run()); assert.equal(calls(), 0); } finally { await db.query(`ALTER TABLE unavailable_memories RENAME TO ${table}`); } } finally { await db.end(); }
        }
        if (backend === "qdrant") { unavailable = true; await assert.rejects(run()); assert.equal(calls(), 0); unavailable = false; }
        await absent(); await reopen(); break;
      }
      case "missing-memory": {
        const existing = (await getMemories(runtime, [preferenceKey(r)]))[0]!; const remove = graph("remove-preference").node("result", "MEMORY.DELETE", [], () => ({ ids: [existing.id] })); nodeValue((await runtime.run(remove, {})).result);
        await assert.rejects(run(), /not found/); assert.equal(calls(), 0); await writeMemories(runtime, fixture.memories); break;
      }
      case "save-not-approved": await assert.rejects(runMemory(runtime, { request: { ...r, remember: false }, model: { provider, model } }), /not enabled/); assert.equal((await getMemories(runtime, [preferenceKey(r)])).length, 0); assert.equal(calls(), 0); break;
      case "invalid-proposal": corrupt = true; await assert.rejects(run(), /not supported/); assert.equal((await getMemories(runtime, [preferenceKey(r)])).length, 0); await absent(); corrupt = false; break;
      case "publication-retry": await writeFile(join(dir, "artifacts"), "occupied"); await assert.rejects(run()); assert.equal(calls(), 1); await rm(join(dir, "artifacts")); await reopen(); break;
      case "write-process-crash": await child("write-crash"); await absent(); await expire(); await child("continue"); break;
      case "update-process-crash": await child("update-crash"); await absent(); await expire(); await child("continue"); break;
      case "progress-process-crash": await child("progress-crash"); await absent(); await expire(); await child("continue"); break;
      case "report-process-crash": await child("report-crash"); await absent(); await expire(); await child("continue"); break;
      case "scope-and-pagination": {
        const foreignNamespace = `team-b:${r.user}`, foreign = await openMemoryStorage({ directory: dir, backend, namespace: foreignNamespace, config }), other = createDitto({ config, workers: foreign.workers });
        let foreignId: string;
        try { foreignId = (await writeMemories(other, [{ key: `${foreignNamespace}:memory:communication`, content: { ...fixture.initial, text: "For project updates, CONFIDENTIAL_TEAM_B prefers English." }, metadata: { kind: "preference" } }]))[0]!.id; if (foreign.database.stats) embeddings += foreign.database.stats.embeddingCalls; }
        finally { await other.close(); await foreign.close(); }
        const hits = await recall(runtime, r); assert.equal(hits[0]!.memory.key, preferenceKey(r)); assert.ok(!JSON.stringify(hits).includes("CONFIDENTIAL_TEAM_B"));
        const byId = graph("foreign-id").node("result", "MEMORY.GET", [], () => ({ ids: [foreignId] })); assert.deepEqual(nodeValue((await runtime.run(byId, {})).result), []);
        const change = graph("foreign-change").node("result", "MEMORY.UPDATE", [], () => ({ memories: [{ id: foreignId, content: "overwrite" }] })); assert.equal((await runtime.run(change, {})).result.status, "failed");
        const pages = graph<{ cursor?: string }>("memory-pagination").node("result", "MEMORY.QUERY", [], i => ({ filter: { kind: "preference" }, limit: 1, ...(i.cursor ? { cursor: i.cursor } : {}) }));
        const first = nodeValue((await runtime.run(pages, {})).result); assert.equal(first.items.length, 1); assert.ok(first.nextCursor); const second = nodeValue((await runtime.run(pages, { cursor: first.nextCursor })).result); assert.equal(second.items.length, 1); assert.notEqual(first.items[0]!.id, second.items[0]!.id); break;
      }
      case "changed-request": await run({ stopAfter: "progress" }); await assert.rejects(runMemory(runtime, { request: { ...r, statement: "Changed task" }, model: { provider, model } }), /Request changed/); break;
      case "cancel-before-work": await assert.rejects(run({ signal: AbortSignal.abort() })); assert.equal(calls(), 0); await absent(); break;
      case "embedding-dimension": {
        const settings = embeddingConfigFromEnv(process.env), actual = createHttpEmbeddingProvider({ ...settings, sandbox: new Sandbox(dir, { network: [new URL(settings.baseUrl).origin] }) });
        await reopen({ async embed(input, context) { return (await actual.embed(input, context)).map(v => v.slice(0, -1)); } }); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      }
      case "embedding-identity": {
        const original = process.env.DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL; process.env.DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL = "changed-model";
        try { await assert.rejects(openMemoryStorage({ directory: dir, backend, namespace: namespace(r), config }), /Embedding model/); } finally { process.env.DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL = original; } break;
      }
    }
    const result = await run() as Report; const mutated = ["write", "update"].includes(scenario.mode);
    assert.equal(result.language, mutated ? "English" : "Chinese"); assert.equal(result.style, mutated ? "detailed" : "concise"); assert.equal(result.version, scenario.mode === "update" ? 2 : 1);
    assert.equal(result.progress.remaining, fixture.project.total - fixture.project.completed); assert.equal(result.progress.ticket, fixture.project.ticket);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "artifacts", `${r.id}.json`), "utf8")), result);
    assert.equal(calls(), (scenario.mode === "search" ? 1 : 2) + (scenario.name === "invalid-proposal" ? 1 : 0));
    const hits = await recall(runtime, r); assert.equal(hits[0]!.memory.key, preferenceKey(r)); assert.ok(hits.every(h => h.memory.metadata?.kind === "preference"));
    if (backend === "qdrant") { assert.ok(hits.every(h => typeof h.score === "number")); if (beforeVector) { const after = await vector(); assert.equal(after!.length, beforeVector.length); assert.notDeepEqual(after, beforeVector); } }
    if (scenario.name === "write-process-crash") assert.equal([...spans, ...children.flatMap(c => c.spans.map(node => ({ node })))].filter(s => s.node === "MEMORY.UPDATE").length, 0);
    if (scenario.name === "update-process-crash") assert.equal([...spans, ...children.flatMap(c => c.spans.map(node => ({ node })))].filter(s => s.node === "MEMORY.UPDATE").length, 1);
    const before = calls(); await expire(); await reopen(); assert.deepEqual(await run(), result); assert.equal(calls(), before);
    assert.equal((await getMemories(runtime, [taskKey(r, "progress"), taskKey(r, "report")])).length, 2);
    if (scenario.name === "update-complete" || scenario.name === "write-complete") {
      const next = { ...r, id: randomUUID(), mode: "search" as const, statement: "", remember: false };
      const later = await runMemory(runtime, { request: next, model: { provider, model } }) as Report; assert.equal(later.language, "English"); assert.equal(later.version, result.version); assert.equal(later.memoryId, result.memoryId); assert.equal(calls(), before + 1); record.futureTask = later.taskId;
    }
    record.status = "passed"; record.result = result;
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally {
    captureStats(); await runtime.close(); await storage.close(); if (proxy) { await new Promise<void>((done, reject) => proxy!.close(error => error ? reject(error) : done())); process.env.DITTO_WORKER_MEMORY_QDRANT_URL = qdrantUrl; }
    Object.assign(record, { spans, children, modelCalls: calls(), embeddingCalls: embeddings + children.reduce((n, c) => n + (c.embeddingCalls ?? 0), 0), vectorQueries: searches + children.reduce((n, c) => n + (c.vectorQueries ?? 0), 0) });
    results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, embeddingModel: process.env.DITTO_WORKER_RETRIEVAL_EMBEDDING_MODEL, directory, results }, null, 2));
    console.log(JSON.stringify({ backend, name: scenario.name, status: record.status, modelCalls: calls(), ...(record.error ? { error: record.error } : {}) }));
  }
}
const failed = results.filter(r => r.status !== "passed"); console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), embeddingCalls: results.reduce((n, r) => n + Number(r.embeddingCalls), 0), vectorQueries: results.reduce((n, r) => n + Number(r.vectorQueries), 0), report: resolve(values.report!) }, null, 2)); if (failed.length) throw new Error(`${failed.length} memory task experiments failed`);
