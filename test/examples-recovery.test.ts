import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { RecoveryStore, operationKey } from "../examples/_shared/tools/recovery-store.ts";
import { startFulfillmentService, type ServiceFaults } from "../examples/_shared/tools/fulfillment-service.ts";
import { createFixture, type Mode } from "../examples/control-flow/recovery/fixtures.ts";
import { runRetry } from "../examples/control-flow/recovery/retry.ts";
import { runFallback } from "../examples/control-flow/recovery/fallback.ts";
import { runTimeout } from "../examples/control-flow/recovery/timeout.ts";
import { runCheckpoint } from "../examples/control-flow/recovery/checkpoint-resume.ts";
import { runPause, resumePaused } from "../examples/control-flow/recovery/pause-resume.ts";
import { runSession } from "../examples/control-flow/recovery/session-resume.ts";
import { runCompensation } from "../examples/control-flow/recovery/compensation.ts";
import { runSideEffectCheck } from "../examples/control-flow/recovery/side-effect-check.ts";
import { action, prepare } from "../examples/control-flow/recovery/shared.ts";
const model = { provider: "unit", model: "unit" };
function answer(input: SampleInput): SampleOutput {
  const items = JSON.parse(String(input.messages[1]!.content));
  let value: unknown;
  if (String(input.messages[0]!.content).startsWith("Answer")) {
    const current = items.find((item: { id: string }) => item.id.endsWith("-current-state")).content;
    value = { sku: current.order.sku, quantity: current.order.quantity, stage: current.stage };
  } else {
    const match = String(items[0].content).match(/SKU: ([^;]+); quantity: (\d+); delivery address: ([^.]+)\./)!;
    value = { sku: match[1], quantity: Number(match[2]), address: match[3] };
  }
  return { message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop" };
}
async function setup(mode: Mode = "checkpoint", faults: ServiceFaults = {}, invoke = async (input: SampleInput) => answer(input)) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-recovery-test-"));
  const fixture = await createFixture(directory, mode);
  const service = await startFulfillmentService(join(directory, "service.sqlite"), [{ sku: fixture.expected.sku, quantity: fixture.stock }], { ...fixture.faults, ...faults });
  let store = new RecoveryStore(directory, service.url), calls = 0;
  const openRuntime = () => createDitto({ sandbox: { tools: store.tools.map(tool => tool.name), network: [service.url] }, workers: [
    createContextWorker(), createInferWorker({ providers: { unit: { async invoke(input) { calls++; return invoke(input); } } } }), createInteractionWorker({ tools: store.tools }),
  ] });
  let runtime = openRuntime();
  await store.create("task", fixture.requiresApproval);
  const input = { id: "task", model };
  return { directory, fixture, service, input, get runtime() { return runtime; }, get store() { return store; }, calls: () => calls,
    writes(path: string) { return Number(service.db.prepare("SELECT count(*) AS n FROM requests WHERE method='POST' AND path=?").get(path)!.n); },
    stock() { return Number(service.db.prepare("SELECT quantity FROM inventory WHERE sku=?").get(fixture.expected.sku)!.quantity); },
    async reopen() { await runtime.close(); store.close(); store = new RecoveryStore(directory, service.url); runtime = openRuntime(); },
    async close() { await runtime.close(); store.close(); await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("reason-aware retry changes byte limit and completes the actual HTTP task", async () => {
  const s = await setup("retry");
  try {
    const result = await runRetry(s.runtime, s.input);
    assert.equal(result.stage, "completed"); assert.deepEqual(result.order, s.fixture.expected); assert.equal(s.calls(), 1);
    const attempts = s.store.db.prepare("SELECT data FROM events WHERE kind='source-read'").all().map(row => JSON.parse(String(row.data)));
    assert.equal(attempts.length, 2); assert.equal(attempts[0].maxBytes, 16); assert.equal(attempts[1].maxBytes, attempts[0].bytes);
    assert.equal(s.writes("/reserve"), 1); assert.equal(s.writes("/ship"), 1); assert.equal(s.stock(), 18);
  } finally { await s.close(); }
});

test("bounded retries preserve terminal reasons and never retry missing or changed input", async () => {
  for (const scenario of ["exhausted", "missing", "changed"] as const) {
    const s = await setup("retry");
    try {
      if (scenario === "missing") await rm(join(s.directory, "task.txt"));
      if (scenario === "changed") await writeFile(join(s.directory, "task.txt"), "another order");
      const result = await runRetry(s.runtime, { ...s.input, maxAttempts: 1 });
      assert.equal(result.stage, "failed"); assert.equal(result.error, scenario === "exhausted" ? "SOURCE_TOO_LARGE" : scenario === "missing" ? "SOURCE_NOT_FOUND" : "SOURCE_CHANGED");
      assert.equal(s.calls(), 0); assert.equal(s.writes("/reserve"), 0);
    } finally { await s.close(); }
  }
});

test("fallback uses an explicitly allowed available source and stops when no permitted source works", async () => {
  for (const allowBackup of [false, true]) {
    const s = await setup("fallback");
    try {
      const result = await runFallback(s.runtime, { ...s.input, allowedSources: allowBackup ? ["primary", "backup"] : ["primary"] });
      assert.equal(result.stage, allowBackup ? "completed" : "failed");
      assert.equal(result.selectedSource, allowBackup ? "backup" : null); assert.equal(s.writes("/reserve"), allowBackup ? 1 : 0);
    } finally { await s.close(); }
  }
});

test("timeouts cancel a real fetch, persist handling state and distinguish caller cancellation", async () => {
  const s = await setup("timeout", { catalogDelayMs: 600 });
  try {
    await prepare(s.runtime, s.input);
    const start = performance.now();
    const result = await runTimeout(s.runtime, { ...s.input, timeoutMs: 30 });
    assert.equal(result.stage, "timed-out"); assert.equal(result.error, "CATALOG_TIMEOUT"); assert.ok(performance.now() - start < 400);
    assert.equal(s.writes("/reserve"), 0);
    await assert.rejects(runTimeout(s.runtime, s.input, { signal: AbortSignal.abort(new Error("caller cancelled")) }), /caller cancelled/);
    assert.equal(s.store.job("task").stage, "timed-out");
  } finally { await s.close(); }
});

test("checkpoint reopening skips inference and confirmed reservation; completed replay has no effects", async () => {
  const s = await setup();
  try {
    const before = await runCheckpoint(s.runtime, s.input, { stopAfter: "reserved" });
    assert.equal(before.stage, "reserved"); assert.equal(s.calls(), 1); assert.equal(s.writes("/ship"), 0);
    await s.reopen();
    assert.equal((await runCheckpoint(s.runtime, s.input)).stage, "completed");
    await runCheckpoint(s.runtime, s.input);
    assert.equal(s.calls(), 1); assert.equal(s.writes("/reserve"), 1); assert.equal(s.writes("/ship"), 1);
    assert.equal(JSON.parse(await readFile(join(s.directory, "results/task.json"), "utf8")).stage, "completed");
  } finally { await s.close(); }
});

test("pause survives reopening and only an order-bound approval permits side effects", async () => {
  for (const decision of ["approve", "reject"] as const) {
    const s = await setup("pause");
    try {
      assert.equal((await runPause(s.runtime, s.input)).stage, "paused");
      assert.equal((await resumePaused(s.runtime, s.input)).stage, "paused"); assert.equal(s.writes("/reserve"), 0);
      await assert.rejects(action(s.runtime, "task", "recovery_operation", { kind: "reserve", apply: true }), /authorized/);
      await s.reopen(); s.store.decide("task", decision, "test-operator");
      const resumed = await resumePaused(s.runtime, s.input);
      assert.equal(resumed.stage, decision === "approve" ? "completed" : "rejected"); assert.equal(s.calls(), 1);
      assert.equal(s.writes("/reserve"), decision === "approve" ? 1 : 0);
      assert.throws(() => s.store.decide("task", "approve", "another-operator"), /awaiting/);
    } finally { await s.close(); }
  }
});

test("changed approval payload is rejected by the operation tool itself", async () => {
  const s = await setup("pause");
  try {
    await runPause(s.runtime, s.input); s.store.decide("task", "approve", "test-operator");
    const job = s.store.job("task"); job.order!.quantity++;
    s.store.db.prepare("UPDATE jobs SET data=? WHERE id='task'").run(JSON.stringify(job));
    await assert.rejects(resumePaused(s.runtime, s.input), /authorized/); assert.equal(s.writes("/reserve"), 0);
  } finally { await s.close(); }
});

test("session reopening restores Context and answers without replaying external actions", async () => {
  const s = await setup();
  try {
    await runCheckpoint(s.runtime, s.input, { stopAfter: "reserved" }); await s.reopen();
    const result = await runSession(s.runtime, { ...s.input, question: "Which order is reserved?" });
    assert.deepEqual(result.answer, { sku: s.fixture.expected.sku, quantity: 2, stage: "reserved" });
    assert.ok(result.job.context!.items.some(item => item.content === "Which order is reserved?"));
    assert.equal(s.writes("/ship"), 0); assert.equal(s.calls(), 2);
    await s.reopen(); assert.ok(s.store.job("task").context!.items.some(item => item.id.includes("-answer-")));
  } finally { await s.close(); }
});

test("compensation restores stock only after confirmed shipping rejection and remains idempotent", async () => {
  const s = await setup("compensation");
  try {
    const result = await runCompensation(s.runtime, s.input);
    assert.equal(result.stage, "compensated"); assert.equal(result.error, "ADDRESS_REJECTED"); assert.equal(s.stock(), 20);
    assert.equal(s.service.lookup(operationKey("task", "ship")).state, "rejected");
    assert.equal(s.service.lookup(operationKey("task", "release")).state, "committed");
    await s.reopen(); await runCompensation(s.runtime, s.input);
    assert.equal(s.writes("/release"), 1); assert.equal(s.stock(), 20);
  } finally { await s.close(); }
});

test("a failed compensation remains needs-review and retains the active reservation", async () => {
  const s = await setup("compensation", { rejectRelease: true });
  try {
    const result = await runCompensation(s.runtime, s.input);
    assert.equal(result.stage, "needs-review"); assert.equal(result.error, "COMPENSATION_RELEASE_REJECTED"); assert.equal(s.stock(), 18);
    await runCompensation(s.runtime, s.input); assert.equal(s.writes("/release"), 1);
  } finally { await s.close(); }
});

test("lost response is reconciled from the service ledger without a duplicate reservation", async () => {
  const s = await setup("side-effect");
  try {
    assert.equal((await runSideEffectCheck(s.runtime, s.input)).stage, "completed");
    assert.equal(s.writes("/reserve"), 1); assert.equal(s.writes("/ship"), 1); assert.equal(s.stock(), 18);
    const lookups = s.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='operation-lookup'").get()!;
    assert.ok(Number(lookups.n) >= 3);
  } finally { await s.close(); }
});

test("unavailable reconciliation remains uncertain until a later reopen can confirm the effect", async () => {
  const s = await setup("side-effect", { lookupUnavailableAfterWrite: true });
  try {
    assert.equal((await runSideEffectCheck(s.runtime, s.input)).stage, "uncertain"); assert.equal(s.writes("/reserve"), 1); assert.equal(s.writes("/ship"), 0);
    await s.reopen(); s.service.faults.lookupUnavailableAfterWrite = false;
    assert.equal((await runSideEffectCheck(s.runtime, s.input)).stage, "completed"); assert.equal(s.writes("/reserve"), 1); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});

test("aborted writes can remain pending; an immediate retry does not duplicate or compensate them", async () => {
  const s = await setup("checkpoint", { reservationDelayMs: 250 });
  try {
    await prepare(s.runtime, s.input);
    await assert.rejects(runSideEffectCheck(s.runtime, s.input, { signal: AbortSignal.timeout(30) }));
    assert.equal(s.service.lookup("task-reserve").state, "pending");
    assert.equal((await runSideEffectCheck(s.runtime, s.input)).stage, "uncertain"); assert.equal(s.writes("/reserve"), 1); assert.equal(s.writes("/release"), 0);
    await setTimeout(270);
    assert.equal((await runSideEffectCheck(s.runtime, s.input)).stage, "completed"); assert.equal(s.stock(), 18); assert.equal(s.writes("/reserve"), 1);
  } finally { await s.close(); }
});

test("remote stable keys reject different payloads instead of reporting an unrelated operation as success", async () => {
  const s = await setup();
  try {
    await runCheckpoint(s.runtime, s.input, { stopAfter: "reserved" });
    const response = await fetch(s.service.url + "/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "task-reserve", order: { ...s.fixture.expected, quantity: 3 }, reservationKey: "task-reserve" }) });
    assert.equal(response.status, 409); assert.equal(s.stock(), 18);
  } finally { await s.close(); }
});

test("invalid or truncated model output cannot checkpoint an order or start external operations", async () => {
  for (const kind of ["invalid", "truncated", "failed"] as const) {
    const s = await setup("checkpoint", {}, async input => {
      if (kind === "failed") throw new Error("Provider unavailable");
      if (kind === "truncated") return { ...answer(input), finishReason: "length" };
      return { message: { role: "assistant", content: '{"sku":"x","quantity":-1,"address":"x"}' }, finishReason: "stop" };
    });
    try { await assert.rejects(runCheckpoint(s.runtime, s.input)); assert.equal(s.store.job("task").stage, "queued"); assert.equal(s.writes("/reserve"), 0); }
    finally { await s.close(); }
  }
});
