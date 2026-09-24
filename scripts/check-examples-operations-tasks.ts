import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { contextScopeKey } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { OperationAdapters, isolatedCode } from "../examples/_shared/tools/operations/adapters.ts";
import { modes, names, note, type Mode } from "../examples/_shared/tools/operations/domain.ts";
import { createFixture } from "../examples/capabilities/tools/fixtures.ts";
import { sandbox } from "../examples/capabilities/tools/cli.ts";
import { runOperations, scope, memoryKey, type Options, type Report } from "../examples/capabilities/tools/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-operations-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-operations-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider; assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const scenarios: { name: string; mode: Mode }[] = [...modes.map(mode => ({ name: `${mode}-complete`, mode })), ...modes.map(mode => ({ name: `${mode}-cache-expiry`, mode })),
  { name: "redis-unavailable", mode: "database" }, { name: "memory-unavailable", mode: "database" }, { name: "business-db-unavailable", mode: "database" },
  { name: "api-unavailable", mode: "api" }, { name: "smtp-unavailable", mode: "message" }, { name: "crm-ambiguous-response", mode: "system-write" },
  { name: "tool-not-allowed", mode: "selection" }, { name: "wrong-parameter", mode: "parameters" }, { name: "path-traversal", mode: "files" }, { name: "input-symlink", mode: "files" },
  { name: "recipient-denied", mode: "message" }, { name: "authorization-denied", mode: "system-write" }, { name: "code-failure", mode: "code" },
  { name: "publication-retry", mode: "api" }, { name: "cancel-before-work", mode: "browser" },
  ...(["message", "system-write", "desktop"] as const).map(mode => ({ name: `${mode}-effect-crash`, mode })), { name: "plan-process-crash", mode: "browser" }, { name: "result-process-crash", mode: "files" },
];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" })); const dir = join(directory, scenario.name); await mkdir(dir); const fixture = await createFixture(dir, scenario.mode), r = fixture.request;
  const spans: { node: string; input: unknown; original?: unknown }[] = [], children: { spans: string[]; modelCalls: number }[] = []; let corrupt: string | undefined, codeFailure = false;
  function observed(d: WorkerDefinition): WorkerDefinition { return { ...d, instantiate() { const w = d.instantiate(); return { async execute(node, input, context) {
    const span: typeof spans[number] = { node, input }; spans.push(span);
    if (codeFailure && node === "INTERACTION.ACT.TOOL" && JSON.stringify(input).includes('"name":"run_code"')) { const altered = structuredClone(input) as { call: { arguments: { code: string } } }; altered.call.arguments.code = "throw new Error('injected failure');"; input = altered; }
    let result = await w.execute(node, input, context);
    if (node === "INFER.REASONING.SAMPLE") { span.original = result; if (corrupt) { const altered = structuredClone(result) as { output: { actionRequests: { name: string; arguments: Record<string, unknown> }[] } }; const action = altered.output.actionRequests[0]!;
      if (corrupt === "tool") action.name = "unregistered_admin"; if (corrupt === "parameter") action.arguments.weight = 999; if (corrupt === "path") action.arguments.output = "../escape.txt"; if (corrupt === "recipient") action.arguments.to = "outside@example.org"; result = altered;
    } }
    return result;
  }, async dispose() { await w.dispose?.(); } }; } }; }
  let storage = await openAgentStorage(dir, config), adapters = new OperationAdapters(dir, r);
  const open = () => createDitto({ config, sandbox: sandbox(config, r), workers: [...storage.workers, createInferWorker(), createInteractionWorker({ tools: adapters.tools })].map(observed) });
  let runtime = open();
  const entry = await import(`../examples/capabilities/tools/${r.mode}.ts`) as { run: typeof runOperations };
  const run = (options: Options = {}): ReturnType<typeof runOperations> => entry.run(runtime, { request: r, model: { provider, model } }, options);
  const reopen = async () => { await runtime.close(); await storage.close(); adapters.close(); storage = await openAgentStorage(dir, config); adapters = new OperationAdapters(dir, r); runtime = open(); };
  const calls = () => spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () => assert.equal(await readFile(join(dir, "artifacts/operation.json")).then(() => true, () => false), false);
  async function expire() { const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(scope(r)); await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null); }
  async function child(phase: string) { await new Promise<void>((done, reject) => { const p = spawn(process.execPath, ["scripts/fixtures/operations-child.ts", "--directory", dir, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; p.stderr.on("data", c => { stderr += String(c); }); p.once("error", reject); p.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr || "Expected process crash")) : code === 0 ? done() : reject(new Error(stderr))); }); children.push(JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8"))); }
  const record: Record<string, unknown> = { name: scenario.name, mode: scenario.mode, status: "failed", directory: dir };
  try {
    if (scenario.name.endsWith("cache-expiry")) { await run({ stopAfter: "plan" }); await expire(); await reopen(); }
    switch (scenario.name) {
      case "redis-unavailable": await storage.redis.quit(); await assert.rejects(run()); assert.equal(calls(), 0); await reopen(); break;
      case "memory-unavailable": { const db = new DatabaseSync(join(dir, "memory.sqlite")); try { db.exec("ALTER TABLE memories RENAME TO missing_memories"); await assert.rejects(run()); assert.equal(calls(), 0); db.exec("ALTER TABLE missing_memories RENAME TO memories"); } finally { db.close(); } await reopen(); break; }
      case "business-db-unavailable": fixture.services.db.exec("ALTER TABLE orders RENAME TO missing_orders"); await assert.rejects(run()); await absent(); fixture.services.db.exec("ALTER TABLE missing_orders RENAME TO orders"); break;
      case "api-unavailable": fixture.services.failApi(true); await assert.rejects(run()); await absent(); fixture.services.failApi(false); break;
      case "smtp-unavailable": fixture.services.failMail(true); await assert.rejects(run()); await absent(); fixture.services.failMail(false); break;
      case "crm-ambiguous-response": fixture.services.dropAfterWrite(); await assert.rejects(run()); assert.equal(fixture.services.db.prepare("SELECT version FROM tickets WHERE id=?").get(r.ticketId)!.version, 2); await absent(); await reopen(); break;
      case "tool-not-allowed": corrupt = "tool"; await assert.rejects(run(), /allowlist/); await absent(); corrupt = undefined; break;
      case "wrong-parameter": corrupt = "parameter"; await assert.rejects(run(), /argument/); await absent(); corrupt = undefined; break;
      case "path-traversal": corrupt = "path"; await assert.rejects(run(), /argument/); await absent(); corrupt = undefined; break;
      case "recipient-denied": corrupt = "recipient"; await assert.rejects(run(), /argument/); assert.equal(fixture.services.db.prepare("SELECT COUNT(*) AS n FROM mail").get()!.n, 0); corrupt = undefined; break;
      case "input-symlink": { await rm(join(dir, "draft.txt")); await writeFile(join(dir, "other.txt"), "Do not follow\n"); await symlink(join(dir, "other.txt"), join(dir, "draft.txt")); await assert.rejects(run(), /Invalid draft/); await absent(); await rm(join(dir, "draft.txt")); await writeFile(join(dir, "draft.txt"), "Order review draft.\n"); break; }
      case "authorization-denied": await assert.rejects(runOperations(runtime, { request: { ...r, authorized: false }, model: { provider, model } }), /authorization/); assert.equal(calls(), 0); break;
      case "code-failure": codeFailure = true; await assert.rejects(run(), /exited/); await absent(); codeFailure = false; break;
      case "publication-retry": await writeFile(join(dir, "artifacts"), "occupied"); await assert.rejects(run()); await rm(join(dir, "artifacts")); await reopen(); break;
      case "cancel-before-work": await assert.rejects(run({ signal: AbortSignal.abort() })); assert.equal(calls(), 0); break;
      case "message-effect-crash": case "system-write-effect-crash": case "desktop-effect-crash": await child("effect-crash"); await absent(); await expire(); await child("continue"); break;
      case "plan-process-crash": await child("plan-crash"); await absent(); await expire(); await child("continue"); break;
      case "result-process-crash": await child("result-crash"); await absent(); await expire(); await child("continue"); break;
    }
    const result = await run() as Report; assert.equal(result.tool, names[r.mode]); assert.equal(result.verified, true);
    assert.equal(calls(), ["tool-not-allowed", "wrong-parameter", "path-traversal", "recipient-denied"].includes(scenario.name) ? 2 : 1);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "artifacts/operation.json"), "utf8")), result);
    if (r.mode === "files") assert.equal(await readFile(join(dir, "final.txt"), "utf8"), "Order review draft.\n" + note(r) + "\n");
    if (r.mode === "browser") { assert.equal(await readFile(join(dir, "download.csv"), "utf8"), `orderId,totalCents\n${r.orderId},${r.quantity * r.unitCents}\n`); assert.ok((await readFile(join(dir, "browser.png"))).length > 1000); }
    if (r.mode === "desktop") { assert.deepEqual(JSON.parse(await readFile(join(dir, "desktop-note.json"), "utf8")), { title: r.ticketId, body: note(r) }); assert.equal(result.evidence.nativeWindowVisible, true); assert.ok((await readFile(join(dir, "desktop.png"))).length > 1000); }
    if (r.mode === "message") { const messages = fixture.services.db.prepare("SELECT recipient,subject,body FROM mail").all(); assert.deepEqual(messages.map(row => ({ ...row })), [{ recipient: r.recipient, subject: r.ticketId, body: note(r) }]); }
    if (r.mode === "system-write") { assert.deepEqual({ ...fixture.services.db.prepare("SELECT status,note,version FROM tickets WHERE id=?").get(r.ticketId) }, { status: "resolved", note: note(r), version: 2 }); assert.equal(fixture.services.db.prepare("SELECT COUNT(*) AS n FROM operations").get()!.n, 1); }
    if (r.mode === "code") { assert.equal(result.evidence.exitCode, 0); assert.equal((result.value as { totalCents: number }).totalCents, r.quantity * r.unitCents); }
    const before = calls(); await expire(); await reopen(); assert.deepEqual(await run(), result); assert.equal(calls(), before);
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true }); try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_key LIKE ?").get(`operations:${r.tenant}:${r.id}:%`)!.n, 4); assert.ok(db.prepare("SELECT content FROM memories WHERE memory_key=?").get(memoryKey(r, "result"))); } finally { db.close(); }
    const allNodes = [...spans.map(s => s.node), ...children.flatMap(c => c.spans)]; for (const node of ["MEMORY.GET", "MEMORY.WRITE", "CONTEXT.LOAD", "INFER.REASONING.SAMPLE", "INTERACTION.ACT.TOOL", "INTERACTION.OBSERVE"]) assert.ok(allNodes.includes(node));
    record.status = "passed"; record.evidence = result.evidence;
  } catch (error) { record.error = error instanceof Error ? error.message : String(error); }
  finally { await runtime.close(); await storage.close(); adapters.close(); await fixture.services.close(); Object.assign(record, { spans, children, modelCalls: calls() }); results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, targets: "Controlled HTTP CRM + SMTP test inbox + SQLite + Chromium + native Electron + Docker", results }, null, 2)); console.log(JSON.stringify({ name: scenario.name, status: record.status, modelCalls: calls(), ...(record.error ? { error: record.error } : {}) })); }
}
// Actual process isolation checks, in addition to the model-generated code task.
await assert.rejects(isolatedCode("while(true) {}", {}), /timed out/);
const safe = await isolatedCode('return {secret:process.env.DITTO_SHARED_PROVIDER_DEEPSEEK_API_KEY ?? null};', {}); assert.deepEqual(safe.output, { secret: null });
const containers = (await promisify(execFile)("docker", ["ps", "--filter", "name=ditto-code-", "--format", "{{.Names}}"])).stdout; assert.equal(containers.trim(), "");
await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, targets: "Controlled HTTP CRM + SMTP test inbox + SQLite + Chromium + native Electron + Docker", isolation: { timeout: true, credentialsNotInherited: true, containersRemoved: true }, results }, null, 2));
const failed = results.filter(r => r.status !== "passed"); console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), isolation: { timeout: true, credentialsNotInherited: true, containersRemoved: true }, report: resolve(values.report!) }, null, 2)); if (failed.length) throw new Error(`${failed.length} operation task experiments failed`);
