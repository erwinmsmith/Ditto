/** Real HTTP models, transactional task effects, wall-clock timers, file events and process restarts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { LifecycleStore, type Stage, type Trigger } from "../examples/_shared/tools/lifecycle-store.ts";
import { createFixture, emitEvent } from "../examples/control-flow/lifecycle/fixtures.ts";
import { runStatusTracking } from "../examples/control-flow/lifecycle/status-tracking.ts";
import { runStateCheck } from "../examples/control-flow/lifecycle/state-check.ts";
import { runSafeStop } from "../examples/control-flow/lifecycle/safe-stop.ts";
import { runScheduled } from "../examples/control-flow/lifecycle/scheduled.ts";
import { runEventTriggered } from "../examples/control-flow/lifecycle/event-triggered.ts";
import { report } from "../examples/control-flow/lifecycle/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-lifecycle-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-lifecycle-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]); const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const input = { id: "task", model: { provider, model } };
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const scenarios: { name: string; stage: Stage; calls: number }[] = [
  { name: "tracked-task-and-idempotent-reentry", stage: "completed", calls: 1 },
  { name: "blocked-until-ready", stage: "completed", calls: 1 },
  { name: "stale-revision-before-work", stage: "blocked", calls: 0 },
  { name: "business-change-during-inference", stage: "blocked", calls: 1 },
  { name: "budget-stop", stage: "stopped", calls: 0 },
  { name: "expired-deadline", stage: "stopped", calls: 0 },
  { name: "cancel-before-work", stage: "stopped", calls: 0 },
  { name: "cancel-in-flight", stage: "stopped", calls: 1 },
  { name: "operator-stop-after-inference", stage: "stopped", calls: 1 },
  { name: "deadline-in-flight", stage: "stopped", calls: 1 },
  { name: "scheduled-no-early-execution", stage: "completed", calls: 1 },
  { name: "scheduled-process-restart", stage: "completed", calls: 1 },
  { name: "file-event-from-independent-process", stage: "completed", calls: 1 },
  { name: "event-process-restart", stage: "completed", calls: 1 },
  { name: "duplicate-event-and-reentry", stage: "completed", calls: 1 },
  { name: "invalid-event-scope", stage: "failed", calls: 0 },
  { name: "cancel-waiting-trigger", stage: "stopped", calls: 0 },
  { name: "concurrent-runner-claim", stage: "completed", calls: 1 },
  { name: "actual-storage-write-failure", stage: "failed", calls: 1 },
  { name: "cancel-after-commit-preserves-effect", stage: "completed", calls: 1 },
];
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const caseDirectory = join(directory, scenario.name); await mkdir(caseDirectory);
  const source = await createFixture(caseDirectory, scenario.name === "blocked-until-ready" ? "state" : "tracking");
  const timed = scenario.name.startsWith("scheduled"), eventDriven = /event|waiting-trigger/.test(scenario.name);
  const dueAt = Date.now() + (scenario.name === "scheduled-process-restart" ? 1800 : 180);
  const trigger: Trigger = timed ? { kind: "time", dueAt } : eventDriven ? { kind: "event" } : { kind: "manual" };
  let store = new LifecycleStore(caseDirectory);
  await store.create("task", trigger, { modelCallBudget: scenario.name === "budget-stop" ? 0 : 1,
    ...(scenario.name === "expired-deadline" ? { deadlineAt: Date.now() - 1 } : scenario.name === "deadline-in-flight" ? { deadlineAt: Date.now() + 120 } : {}),
  });
  const spans: Record<string, unknown>[] = [], children: Record<string, unknown>[] = [], controller = new AbortController();
  let afterSample: (() => void) | undefined;
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  function observed(definition: WorkerDefinition): WorkerDefinition { return { ...definition, instantiate() { const worker = definition.instantiate(); return {
    async execute(node, args, context) {
      const span: Record<string, unknown> = { node, ...context.execution, start: Date.now() }; spans.push(span);
      if (node === "INFER.REASONING.SAMPLE") {
        assert.equal(store.job("task").stage, "running");
        if (scenario.name === "cancel-in-flight") abortTimer = setTimeout(() => controller.abort(), 100);
      }
      try {
        const value = await worker.execute(node, args, context);
        if (value && typeof value === "object" && "status" in value) span.status = value.status;
        if (value && typeof value === "object" && "output" in value && value.output && typeof value.output === "object" && "usage" in value.output) span.usage = value.output.usage;
        if (node === "INFER.REASONING.SAMPLE") afterSample?.();
        if (node === "INTERACTION.ACT.TOOL" && scenario.name === "cancel-after-commit-preserves-effect" && store.job("task").stage === "completed") controller.abort();
        return value;
      } finally { span.end = Date.now(); span.aborted = context.signal?.aborted ?? false; }
    }, async dispose() { await worker.dispose?.(); },
  }; } }; }
  const open = () => createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(t => t.name) }, workers: [observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools }))] });
  let runtime = open();
  const reopen = async () => { await runtime.close(); store.close(); store = new LifecycleStore(caseDirectory); runtime = open(); };
  const incoming = { id: "event-1", type: "release.ready" as const, taskId: "task", releaseId: source.id, revision: source.revision };
  async function child(phase: string) {
    const processResult = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      const process = spawn(globalThis.process.execPath, ["scripts/fixtures/lifecycle-child.ts", "--directory", caseDirectory, "--phase", phase, "--provider", provider!], { env: globalThis.process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; process.stderr.on("data", data => { stderr += String(data); }); process.once("error", reject);
      process.once("exit", (code, signal) => { if (phase === "waiting-crash" ? signal === "SIGKILL" : code === 0) done({ code, signal }); else reject(new Error(`Child failed: ${stderr}`)); });
    });
    const saved = await readJson(join(caseDirectory, `child-${phase}.json`)); children.push({ ...saved, ...processResult }); return saved;
  }
  const result: Record<string, unknown> = { name: scenario.name, status: "failed", directory: caseDirectory };
  try {
    switch (scenario.name) {
      case "tracked-task-and-idempotent-reentry": await runStatusTracking(runtime, input); await reopen(); await runStatusTracking(runtime, input); break;
      case "blocked-until-ready": assert.equal((await runStateCheck(runtime, input)).job.stage, "blocked"); assert.equal(store.job("task").modelCalls, 0); await reopen(); store.updateBusiness({ ...source, status: "ready" }); await runStateCheck(runtime, input); break;
      case "stale-revision-before-work": store.updateBusiness({ ...source, revision: 2 }); await runStateCheck(runtime, input); break;
      case "business-change-during-inference": afterSample = () => store.updateBusiness({ ...source, revision: 2 }); await runStateCheck(runtime, input); break;
      case "budget-stop": case "expired-deadline": case "deadline-in-flight": await runSafeStop(runtime, input); break;
      case "cancel-before-work": controller.abort(); await runSafeStop(runtime, input, { signal: controller.signal }); break;
      case "cancel-in-flight": case "cancel-after-commit-preserves-effect": await runSafeStop(runtime, input, { signal: controller.signal }); break;
      case "operator-stop-after-inference": afterSample = () => { store.requestStop("task"); }; await runSafeStop(runtime, input); break;
      case "scheduled-no-early-execution": assert.equal((await runScheduled(runtime, input, { waitMs: 0 })).job.stage, "waiting"); assert.equal(store.job("task").modelCalls, 0); await runScheduled(runtime, input, { waitMs: 2000 }); break;
      case "scheduled-process-restart": assert.equal((await child("waiting-crash")).result.job.stage, "waiting"); await child("continue"); break;
      case "file-event-from-independent-process": { assert.equal((await runEventTriggered(runtime, input, { waitMs: 0 })).job.stage, "waiting"); const producer = child("produce-event"); await runEventTriggered(runtime, input, { waitMs: 5000 }); await producer; break; }
      case "event-process-restart": assert.equal((await child("waiting-crash")).result.job.stage, "waiting"); await child("produce-event"); await child("continue"); break;
      case "duplicate-event-and-reentry": await emitEvent(caseDirectory, incoming); await runEventTriggered(runtime, input); store.acceptEvent(incoming); assert.throws(() => store.acceptEvent({ ...incoming, revision: 2 }), /conflict/); await reopen(); await runEventTriggered(runtime, input); break;
      case "invalid-event-scope": await emitEvent(caseDirectory, { ...incoming, revision: 2 }); await runEventTriggered(runtime, input); break;
      case "cancel-waiting-trigger": { const pending = runEventTriggered(runtime, input, { signal: controller.signal }); await delay(30); controller.abort(); await pending; await emitEvent(caseDirectory, incoming); await runEventTriggered(runtime, input); break; }
      case "concurrent-runner-claim": await Promise.all([runStatusTracking(runtime, input), runStatusTracking(runtime, input)]); break;
      case "actual-storage-write-failure": store.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON notices BEGIN SELECT RAISE(ABORT, 'notice storage unavailable'); END;"); await runStatusTracking(runtime, input); break;
    }
    const saved = await report(runtime, "task"); assert.equal(saved.job.stage, scenario.stage);
    const effects = Number(store.db.prepare("SELECT count(*) AS n FROM notices").get()!.n);
    assert.equal(effects, saved.job.stage === "completed" ? 1 : 0);
    if (saved.notice) { assert.equal(saved.notice.releaseId, source.id); assert.equal(saved.notice.revision, source.revision); assert.equal(saved.notice.title, source.title); assert.ok(saved.notice.body.includes(source.change)); }
    if (timed) assert.ok(saved.history.find(h => h.stage === "running")!.at >= dueAt);
    if (scenario.name === "cancel-in-flight" || scenario.name === "deadline-in-flight") { assert.ok(spans.find(x => x.node === "INFER.REASONING.SAMPLE")?.aborted); assert.equal(saved.job.reason, scenario.name === "cancel-in-flight" ? "CALLER_CANCELLED" : "DEADLINE"); }
    const calls = spans.filter(x => x.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + Number(c.modelCalls), 0); assert.equal(calls, scenario.calls);
    assert.ok(spans.every(span => typeof span.end === "number"));
    await reopen(); assert.deepEqual(store.result("task"), saved); assert.deepEqual(await readJson(join(caseDirectory, "results/task.json")), saved);
    Object.assign(result, { status: "passed", result: saved, reopened: true });
  } catch (error) { result.error = error instanceof Error ? error.message : "Lifecycle acceptance failure"; }
  finally {
    if (abortTimer) clearTimeout(abortTimer); await runtime.close(); store.close();
    Object.assign(result, { spans, children, modelCalls: spans.filter(x => x.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, c) => n + Number(c.modelCalls), 0) }); results.push(result);
    await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, results }, null, 2));
    console.log(JSON.stringify({ name: scenario.name, status: result.status, modelCalls: result.modelCalls, ...(result.error ? { error: result.error } : {}) }));
  }
}
const failed = results.filter(r => r.status !== "passed");
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2));
if (failed.length) throw new Error(`${failed.length} lifecycle task experiments failed`);
