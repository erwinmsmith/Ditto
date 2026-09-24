import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { LifecycleStore, type Trigger } from "../examples/_shared/tools/lifecycle-store.ts";
import { createFixture, emitEvent, type Mode } from "../examples/control-flow/lifecycle/fixtures.ts";
import { runStatusTracking } from "../examples/control-flow/lifecycle/status-tracking.ts";
import { runStateCheck } from "../examples/control-flow/lifecycle/state-check.ts";
import { runSafeStop } from "../examples/control-flow/lifecycle/safe-stop.ts";
import { runScheduled } from "../examples/control-flow/lifecycle/scheduled.ts";
import { runEventTriggered } from "../examples/control-flow/lifecycle/event-triggered.ts";
function answer(input: SampleInput): SampleOutput { const source = JSON.parse(String(input.messages[1]!.content))[0].content; return { message: { role: "assistant", content: JSON.stringify({ releaseId: source.id, revision: source.revision, title: source.title, body: source.change }) }, finishReason: "stop" }; }
async function setup(options: { mode?: Mode; trigger?: Trigger; deadlineAt?: number; modelCallBudget?: number; invoke?: (input: SampleInput, signal?: AbortSignal) => Promise<SampleOutput> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-lifecycle-test-"));
  const source = await createFixture(directory, options.mode ?? "tracking");
  let store = new LifecycleStore(directory), calls = 0;
  const open = () => createDitto({ sandbox: { tools: store.tools.map(t => t.name) }, workers: [createContextWorker(), createInferWorker({ providers: { unit: { async invoke(input, context) { calls++; return options.invoke ? options.invoke(input, context?.signal) : answer(input); } } } }), createInteractionWorker({ tools: store.tools })] });
  let runtime = open();
  await store.create("task", options.trigger ?? { kind: "manual" }, { ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }), ...(options.modelCallBudget === undefined ? {} : { modelCallBudget: options.modelCallBudget }) });
  return { directory, source, input: { id: "task", model: { provider: "unit", model: "unit" } }, get runtime() { return runtime; }, get store() { return store; }, calls: () => calls,
    event: { id: "event-1", type: "release.ready" as const, taskId: "task", releaseId: source.id, revision: source.revision },
    async reopen() { await runtime.close(); store.close(); store = new LifecycleStore(directory); runtime = open(); },
    async close() { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("lifecycle tracks queued/running/completed, commits actual notice and reopens idempotently", async () => {
  const s = await setup(); try {
    const result = await runStatusTracking(s.runtime, s.input); assert.deepEqual(result.history.map(x => x.stage), ["queued", "running", "completed"]); assert.equal(result.notice!.body, s.source.change);
    assert.deepEqual(JSON.parse(await readFile(join(s.directory, "results/task.json"), "utf8")), result);
    await s.reopen(); assert.deepEqual(s.store.result("task"), result); assert.deepEqual(await runStatusTracking(s.runtime, s.input), result); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});
test("state check blocks inference until business ready and refuses outdated revisions", async () => {
  const s = await setup({ mode: "state" }); try {
    assert.equal((await runStateCheck(s.runtime, s.input)).job.stage, "blocked"); assert.equal(s.calls(), 0);
    await s.reopen(); s.store.updateBusiness({ ...s.source, status: "ready" }); assert.equal((await runStateCheck(s.runtime, s.input)).job.stage, "completed");
  } finally { await s.close(); }
  const stale = await setup(); try { stale.store.updateBusiness({ ...stale.source, revision: 2 }); assert.equal((await runStateCheck(stale.runtime, stale.input)).job.stage, "blocked"); assert.equal(stale.calls(), 0); } finally { await stale.close(); }
});
test("state mutation during inference blocks the transaction and never registers stale content", async () => {
  const s = await setup({ invoke: async input => { s.store.updateBusiness({ ...s.source, revision: 2 }); return answer(input); } });
  try { const r = await runStateCheck(s.runtime, s.input); assert.equal(r.job.stage, "blocked"); assert.equal(r.job.reason, "BUSINESS_CHANGED"); assert.equal(r.notice, null); } finally { await s.close(); }
});
test("safe stop persists budget exhaustion, expired deadline and pre-cancel without inference", async () => {
  for (const reason of ["MODEL_CALL_BUDGET", "DEADLINE", "CALLER_CANCELLED"] as const) {
    const s = await setup(reason === "MODEL_CALL_BUDGET" ? { modelCallBudget: 0 } : reason === "DEADLINE" ? { deadlineAt: Date.now() - 1 } : {});
    try { const r = await runSafeStop(s.runtime, s.input, reason === "CALLER_CANCELLED" ? { signal: AbortSignal.abort() } : {}); assert.equal(r.job.stage, "stopped"); assert.equal(r.job.reason, reason); assert.equal(s.calls(), 0); await s.reopen(); assert.equal((await runSafeStop(s.runtime, s.input)).notice, null); } finally { await s.close(); }
  }
});
test("abort reaches provider and prevents commit, while cleanup records the stop outside the aborted graph", async () => {
  const controller = new AbortController(); let observed = false;
  const s = await setup({ invoke: async (input, signal) => { controller.abort(); try { await delay(100, undefined, { signal: signal! }); } catch { observed = !!signal?.aborted; throw new Error("aborted"); } return answer(input); } });
  try { const r = await runSafeStop(s.runtime, s.input, { signal: controller.signal }); assert.equal(r.job.reason, "CALLER_CANCELLED"); assert.equal(r.notice, null); assert.equal(observed, true); } finally { await s.close(); }
});
test("deadline aborts an in-flight provider and blocks subsequent work", async () => {
  const s = await setup({ deadlineAt: Date.now() + 80, invoke: async (input, signal) => { await delay(200, undefined, { signal: signal! }); return answer(input); } });
  try { const r = await runSafeStop(s.runtime, s.input); assert.equal(r.job.reason, "DEADLINE"); assert.equal(r.notice, null); } finally { await s.close(); }
});
test("trusted operator stop during inference cannot be overwritten by a late model result", async () => {
  const s = await setup({ invoke: async input => { s.store.requestStop("task"); return answer(input); } });
  try { const r = await runSafeStop(s.runtime, s.input); assert.equal(r.job.reason, "OPERATOR_STOP"); assert.equal(r.notice, null); } finally { await s.close(); }
});
test("failed, invalid and truncated model outputs produce a durable failed state without a notice", async () => {
  for (const kind of ["failed", "invalid", "truncated"] as const) {
    const s = await setup({ invoke: async input => { if (kind === "failed") throw new Error("provider unavailable"); const output = answer(input); if (kind === "invalid") output.message.content = "{}"; else output.finishReason = "length"; return output; } });
    try { const r = await runStatusTracking(s.runtime, s.input); assert.equal(r.job.stage, "failed"); assert.equal(r.notice, null); await s.reopen(); assert.equal((await runStatusTracking(s.runtime, s.input)).job.stage, "failed"); assert.equal(s.calls(), 1); } finally { await s.close(); }
  }
});
test("schedule is durable, cannot start early, and starts only once after actual wall-clock due time", async () => {
  const dueAt = Date.now() + 150, s = await setup({ trigger: { kind: "time", dueAt } });
  try { assert.equal((await runScheduled(s.runtime, s.input, { waitMs: 0 })).job.stage, "waiting"); assert.equal(s.calls(), 0); await s.reopen(); const r = await runScheduled(s.runtime, s.input, { waitMs: 1000 }); assert.equal(r.job.stage, "completed"); assert.ok(r.history.find(x => x.stage === "running")!.at >= dueAt); await runScheduled(s.runtime, s.input); assert.equal(s.calls(), 1); } finally { await s.close(); }
});
test("event files activate a full task, duplicate delivery is idempotent and conflicting IDs are rejected", async () => {
  const s = await setup({ trigger: { kind: "event" } }); try {
    assert.equal((await runEventTriggered(s.runtime, s.input, { waitMs: 0 })).job.stage, "waiting"); assert.equal(s.calls(), 0);
    const pending = runEventTriggered(s.runtime, s.input, { waitMs: 1000 }); await delay(30); await emitEvent(s.directory, s.event);
    assert.equal((await pending).job.stage, "completed"); assert.equal(s.store.acceptEvent(s.event).stage, "completed");
    assert.throws(() => s.store.acceptEvent({ ...s.event, revision: 2 }), /conflict/); await s.reopen(); await runEventTriggered(s.runtime, s.input); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});
test("invalid event scope fails without inference and never becomes a business effect", async () => {
  const s = await setup({ trigger: { kind: "event" } }); try { await emitEvent(s.directory, { ...s.event, revision: 2 }); const r = await runEventTriggered(s.runtime, s.input); assert.equal(r.job.stage, "failed"); assert.equal(r.job.reason, "TRIGGER_INVALID"); assert.equal(s.calls(), 0); assert.equal(r.notice, null); } finally { await s.close(); }
});
test("cancel while waiting for timer/event stops persistently; later triggers cannot reactivate", async () => {
  for (const trigger of [{ kind: "event" }, { kind: "time", dueAt: Date.now() + 10_000 }] as const) {
    const s = await setup({ trigger }); const controller = new AbortController();
    try { const run = trigger.kind === "time" ? runScheduled : runEventTriggered; const pending = run(s.runtime, s.input, { signal: controller.signal }); await delay(20); controller.abort(); const r = await pending; assert.equal(r.job.stage, "stopped"); if (trigger.kind === "event") s.store.acceptEvent(s.event); assert.equal((await run(s.runtime, s.input)).job.stage, "stopped"); assert.equal(s.calls(), 0); } finally { await s.close(); }
  }
});
test("concurrent runners use one execution owner and one actual business notice", async () => {
  const s = await setup({ invoke: async input => { await delay(30); return answer(input); } });
  try { const output = await Promise.all([runStatusTracking(s.runtime, s.input), runStatusTracking(s.runtime, s.input)]); assert.ok(output.some(r => r.job.stage === "completed")); assert.equal(s.calls(), 1); assert.equal(s.store.result("task").job.stage, "completed"); } finally { await s.close(); }
});
test("business updates require a new revision for content and invalid source input creates no task", async () => {
  const s = await setup(); try { assert.throws(() => s.store.updateBusiness({ ...s.source, change: "changed" }), /revision/); await writeFile(join(s.directory, "other.source.json"), JSON.stringify({ ...s.source, revision: -1 })); await assert.rejects(s.store.create("other")); assert.throws(() => s.store.job("other"), /Unknown/); } finally { await s.close(); }
});
