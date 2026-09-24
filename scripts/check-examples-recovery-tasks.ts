/** End-to-end recovery acceptance: real models, real HTTP/SQLite effects, killed and restarted processes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { RecoveryStore, type Job } from "../examples/_shared/tools/recovery-store.ts";
import { startFulfillmentService, type ServiceFaults } from "../examples/_shared/tools/fulfillment-service.ts";
import { createFixture, type Mode } from "../examples/control-flow/recovery/fixtures.ts";
import { runRetry } from "../examples/control-flow/recovery/retry.ts";
import { runFallback } from "../examples/control-flow/recovery/fallback.ts";
import { runTimeout } from "../examples/control-flow/recovery/timeout.ts";
import { runCheckpoint } from "../examples/control-flow/recovery/checkpoint-resume.ts";
import { runPause, resumePaused } from "../examples/control-flow/recovery/pause-resume.ts";
import { runCompensation } from "../examples/control-flow/recovery/compensation.ts";
import { runSideEffectCheck } from "../examples/control-flow/recovery/side-effect-check.ts";
import { prepare, report } from "../examples/control-flow/recovery/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-recovery-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-recovery-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined); assert.ok(modelName);
const input = { id: "task", model: { provider, model: modelName } };
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const cases: { name: string; mode: Mode; faults?: ServiceFaults; expected: Job["stage"]; modelCalls: number }[] = [
  { name: "retry-adjusts-read-limit", mode: "retry", expected: "completed", modelCalls: 1 },
  { name: "retry-exhausted", mode: "retry", expected: "failed", modelCalls: 0 },
  { name: "retry-permanent-missing-source", mode: "retry", expected: "failed", modelCalls: 0 },
  { name: "fallback-allowed-backup", mode: "fallback", expected: "completed", modelCalls: 1 },
  { name: "fallback-disallowed-backup", mode: "fallback", expected: "failed", modelCalls: 1 },
  { name: "fallback-does-not-hide-business-rejection", mode: "fallback", faults: { primaryUnavailable: false }, expected: "failed", modelCalls: 1 },
  { name: "read-deadline", mode: "timeout", expected: "timed-out", modelCalls: 1 },
  { name: "read-before-deadline", mode: "timeout", faults: { catalogDelayMs: 0 }, expected: "completed", modelCalls: 1 },
  { name: "checkpoint-process-crash-and-resume", mode: "checkpoint", expected: "completed", modelCalls: 1 },
  { name: "pause-process-crash-and-approve", mode: "pause", expected: "completed", modelCalls: 1 },
  { name: "pause-rejected", mode: "pause", expected: "rejected", modelCalls: 1 },
  { name: "session-in-a-new-process", mode: "session", expected: "reserved", modelCalls: 2 },
  { name: "compensation-restores-inventory", mode: "compensation", expected: "compensated", modelCalls: 1 },
  { name: "compensation-failed-needs-review", mode: "compensation", faults: { rejectRelease: true }, expected: "needs-review", modelCalls: 1 },
  { name: "lost-response-reconciled", mode: "side-effect", expected: "completed", modelCalls: 1 },
  { name: "unknown-effect-crash-and-reconcile", mode: "side-effect", faults: { lookupUnavailableAfterWrite: true }, expected: "completed", modelCalls: 1 },
  { name: "pending-write-no-duplicate-retry", mode: "checkpoint", faults: { reservationDelayMs: 350 }, expected: "completed", modelCalls: 1 },
  { name: "lookup-unavailable-no-blind-write", mode: "checkpoint", faults: { lookupUnavailable: true }, expected: "uncertain", modelCalls: 1 },
  { name: "completed-task-idempotent-reentry", mode: "checkpoint", expected: "completed", modelCalls: 1 },
  { name: "caller-cancelled-before-work", mode: "checkpoint", expected: "queued", modelCalls: 0 },
];
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of cases) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const caseDirectory = join(directory, scenario.name); await mkdir(caseDirectory);
  const fixture = await createFixture(caseDirectory, scenario.mode);
  const servicePath = join(caseDirectory, "service.sqlite");
  let service = await startFulfillmentService(servicePath, [{ sku: fixture.expected.sku, quantity: fixture.stock }], { ...fixture.faults, ...scenario.faults });
  let store = new RecoveryStore(caseDirectory, service.url); await store.create("task", fixture.requiresApproval);
  const spans: Record<string, unknown>[] = [], children: Record<string, unknown>[] = [];
  function observed(definition: WorkerDefinition): WorkerDefinition {
    return { ...definition, instantiate() { const worker = definition.instantiate(); return {
      async execute(node, args, context) {
        const span: Record<string, unknown> = { node, ...context.execution, start: performance.now() }; spans.push(span);
        try {
          const output = await worker.execute(node, args, context);
          if (output && typeof output === "object" && "status" in output) span.status = output.status;
          if (output && typeof output === "object" && "output" in output && output.output && typeof output.output === "object" && "usage" in output.output) span.usage = output.output.usage;
          return output;
        } finally { span.end = performance.now(); }
      }, async dispose() { await worker.dispose?.(); },
    }; } };
  }
  const openRuntime = () => createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name), network: [...config.sandbox.network ?? [], service.url] }, workers: [
    observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools })),
  ] });
  let runtime = openRuntime();
  const writes = (path: string) => Number(service.db.prepare("SELECT count(*) AS n FROM requests WHERE method='POST' AND path=?").get(path)!.n);
  const stock = () => Number(service.db.prepare("SELECT quantity FROM inventory WHERE sku=?").get(fixture.expected.sku)!.quantity);
  const reopen = async () => { await runtime.close(); store.close(); store = new RecoveryStore(caseDirectory, service.url); runtime = openRuntime(); };
  async function child(mode: string) {
    await runtime.close(); store.close();
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ["scripts/fixtures/recovery-child.ts", "--directory", caseDirectory, "--url", service.url, "--mode", mode, "--provider", provider!], { cwd: globalThis.process.cwd(), env: globalThis.process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; process.stderr.on("data", data => { stderr += String(data); });
      process.once("error", reject); process.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    store = new RecoveryStore(caseDirectory, service.url); runtime = openRuntime();
    if (mode.endsWith("-crash")) assert.equal(outcome.signal, "SIGKILL", outcome.stderr);
    else assert.equal(outcome.code, 0, outcome.stderr);
    const artifact = JSON.parse(await readFile(join(caseDirectory, `child-${mode}.json`), "utf8"));
    children.push({ mode, ...outcome, ...artifact }); return artifact;
  }
  const result: Record<string, unknown> = { name: scenario.name, status: "failed", directory: caseDirectory };
  try {
    switch (scenario.name) {
      case "retry-adjusts-read-limit": {
        await runRetry(runtime, input);
        const reads = store.db.prepare("SELECT data FROM events WHERE kind='source-read'").all().map(row => JSON.parse(String(row.data)));
        assert.equal(reads.length, 2); assert.equal(reads[0].maxBytes, 16); assert.equal(reads[1].maxBytes, reads[0].bytes); break;
      }
      case "retry-exhausted": await runRetry(runtime, { ...input, maxAttempts: 1 }); assert.equal(store.job("task").error, "SOURCE_TOO_LARGE"); break;
      case "retry-permanent-missing-source": await rm(join(caseDirectory, "task.txt")); await runRetry(runtime, input); assert.equal(store.job("task").error, "SOURCE_NOT_FOUND"); break;
      case "fallback-allowed-backup": await runFallback(runtime, input); assert.equal(store.job("task").selectedSource, "backup"); break;
      case "fallback-disallowed-backup": await runFallback(runtime, { ...input, allowedSources: ["primary"] }); assert.equal(store.job("task").selectedSource, null); break;
      case "fallback-does-not-hide-business-rejection":
        service.db.prepare("UPDATE inventory SET quantity=0").run(); await runFallback(runtime, input);
        assert.equal(store.job("task").error, "INSUFFICIENT_STOCK");
        assert.equal(Number(service.db.prepare("SELECT count(*) AS n FROM requests WHERE path='/catalog/backup'").get()!.n), 0); break;
      case "read-deadline": {
        await prepare(runtime, input); const started = performance.now();
        await runTimeout(runtime, { ...input, timeoutMs: 50 });
        result.deadlineElapsedMs = performance.now() - started;
        assert.ok(Number(result.deadlineElapsedMs) < 350); assert.equal(store.job("task").error, "CATALOG_TIMEOUT"); break;
      }
      case "read-before-deadline": await runTimeout(runtime, { ...input, timeoutMs: 1000 }); break;
      case "checkpoint-process-crash-and-resume": {
        const first = await child("reserve-crash"); assert.equal(first.result.stage, "reserved"); assert.equal(writes("/ship"), 0);
        const second = await child("resume"); assert.notEqual(first.pid, second.pid); assert.equal(second.modelCalls, 0); break;
      }
      case "pause-process-crash-and-approve": {
        await child("pause-crash"); assert.equal(store.job("task").stage, "paused"); assert.equal(writes("/reserve"), 0);
        store.decide("task", "approve", "experiment-operator");
        assert.equal((await child("approved-resume")).modelCalls, 0); break;
      }
      case "pause-rejected":
        await runPause(runtime, input); await reopen(); store.decide("task", "reject", "experiment-operator"); await resumePaused(runtime, input); break;
      case "session-in-a-new-process": {
        const first = await child("reserve-crash"), restored = await child("session");
        assert.notEqual(first.pid, restored.pid); assert.deepEqual(restored.result.answer, { sku: fixture.expected.sku, quantity: fixture.expected.quantity, stage: "reserved" });
        assert.ok(store.job("task").context!.items.some(item => item.id.includes("-answer-"))); assert.equal(writes("/ship"), 0); break;
      }
      case "compensation-restores-inventory":
        await runCompensation(runtime, input); assert.equal(stock(), fixture.stock); assert.equal(writes("/release"), 1);
        await reopen(); await runCompensation(runtime, input); assert.equal(writes("/release"), 1); assert.equal(store.job("task").error, "ADDRESS_REJECTED"); break;
      case "compensation-failed-needs-review":
        await runCompensation(runtime, input); assert.equal(stock(), fixture.stock - fixture.expected.quantity); assert.equal(store.job("task").error, "COMPENSATION_RELEASE_REJECTED"); break;
      case "lost-response-reconciled": await runSideEffectCheck(runtime, input); assert.equal(writes("/reserve"), 1); break;
      case "unknown-effect-crash-and-reconcile":
        await child("lost-crash"); assert.equal(store.job("task").stage, "uncertain"); assert.equal(writes("/reserve"), 1); assert.equal(writes("/ship"), 0);
        service.faults.lookupUnavailableAfterWrite = false; assert.equal((await child("resume")).modelCalls, 0); assert.equal(writes("/reserve"), 1); break;
      case "pending-write-no-duplicate-retry":
        await prepare(runtime, input);
        await assert.rejects(runSideEffectCheck(runtime, input, { signal: AbortSignal.timeout(50) }));
        assert.equal(service.lookup("task-reserve").state, "pending");
        await runSideEffectCheck(runtime, input); assert.equal(store.job("task").stage, "uncertain"); assert.equal(writes("/reserve"), 1); assert.equal(writes("/release"), 0);
        await setTimeout(380); await reopen(); await runSideEffectCheck(runtime, input); break;
      case "lookup-unavailable-no-blind-write": await runSideEffectCheck(runtime, input); assert.equal(writes("/reserve"), 0); break;
      case "completed-task-idempotent-reentry": await runCheckpoint(runtime, input); await reopen(); await runCheckpoint(runtime, input); break;
      case "caller-cancelled-before-work": await assert.rejects(runCheckpoint(runtime, input, { signal: AbortSignal.abort(new Error("cancel acceptance")) }), /cancel acceptance/); break;
    }
    const job = await report(runtime, "task");
    assert.equal(job.stage, scenario.expected);
    if (job.order) assert.deepEqual(job.order, fixture.expected);
    if (job.stage === "completed") { assert.ok(job.shipment); assert.equal(writes("/reserve"), 1); assert.equal(writes("/ship"), 1); assert.equal(stock(), fixture.stock - fixture.expected.quantity); }
    if (["failed", "timed-out", "rejected", "queued"].includes(job.stage)) assert.equal(writes("/reserve"), 0);
    const callCount = spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length + children.reduce((sum, child) => sum + Number(child.modelCalls), 0);
    assert.equal(callCount, scenario.modelCalls);
    assert.ok(spans.every(span => typeof span.end === "number"));
    const ledger = { inventory: service.db.prepare("SELECT * FROM inventory").all(), reservations: service.db.prepare("SELECT * FROM reservations").all(), shipments: service.db.prepare("SELECT * FROM shipments").all(), operations: service.db.prepare("SELECT * FROM operations").all(), requests: service.db.prepare("SELECT * FROM requests ORDER BY seq").all() };
    await runtime.close(); store.close(); await service.close();
    // Restart both stores; no task Runtime or service memory survives the verification boundary.
    service = await startFulfillmentService(servicePath, []); store = new RecoveryStore(caseDirectory, service.url); runtime = openRuntime();
    assert.deepEqual(store.job("task"), job);
    assert.deepEqual(JSON.parse(await readFile(join(caseDirectory, "results/task.json"), "utf8")), job);
    for (const table of ["inventory", "reservations", "shipments", "operations"] as const) assert.deepEqual(service.db.prepare(`SELECT * FROM ${table}`).all(), ledger[table]);
    Object.assign(result, { status: "passed", checkpoint: job, ledger, reopened: true, modelCalls: callCount });
  } catch (error) { result.error = error instanceof Error ? error.message : "Unknown task error"; }
  finally {
    await runtime.close(); store.close(); await service.close();
    Object.assign(result, { spans, children, modelCalls: spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length + children.reduce((sum, child) => sum + Number(child.modelCalls), 0) });
    results.push(result);
    await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model: modelName, directory, results }, null, 2));
    console.log(JSON.stringify({ name: scenario.name, status: result.status, modelCalls: result.modelCalls, ...(result.error ? { error: result.error } : {}) }));
  }
}
const failed = results.filter(result => result.status !== "passed");
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, row) => n + Number(row.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2));
if (failed.length) throw new Error(`${failed.length} recovery task experiments failed`);
