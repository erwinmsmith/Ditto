import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { createDitto } from "@ditto/core/runtime";
import { createInferWorker, type SampleInput, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createOrderFiles, readJson, type OrderReport } from "../examples/_shared/tools/order-files.ts";
import { runParallel } from "../examples/control-flow/parallel/concurrency-limit.ts";
import { runSummary } from "../examples/control-flow/parallel/fan-out-fan-in.ts";
import { runPlanning, validatePlan } from "../examples/control-flow/parallel/planning.ts";
import { runPartial } from "../examples/control-flow/parallel/partial-results.ts";
import type { BatchInput, Source } from "../examples/control-flow/parallel/shared.ts";

const model = { provider: "unit", model: "unit" };
const response = (data: unknown): SampleOutput => ({ message: { role: "assistant", content: JSON.stringify(data) }, finishReason: "stop" });
// Deterministic regressions only. The separate task acceptance command uses actual HTTP providers.
async function setup(count = 3, invoke?: (input: SampleInput, signal: AbortSignal) => Promise<SampleOutput>, rejectDelivery = false) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-parallel-test-"));
  const inputDirectory = join(directory, "input"), outputDirectory = join(directory, "output");
  await mkdir(inputDirectory);
  const sources: Source[] = [];
  for (let index = 0; index < count; index++) {
    const id = `order-${index}`, path = join(inputDirectory, `${id}.json`);
    await writeFile(path, JSON.stringify({ code: `CODE-${index}`, quantity: index + 1, unitPriceCents: 100 }));
    sources.push({ id, path, description: `Independent order ${index}` });
  }
  const input: BatchInput = { id: "batch", sources, model };
  const adapter = createOrderFiles({ inputDirectory, outputDirectory });
  let calls = 0, active = 0, peak = 0, delivered = 0;
  const runtime = createDitto({ sandbox: { tools: adapter.tools.map(tool => tool.name) }, workers: [
    createInferWorker({ providers: { unit: { async invoke(input, options) {
      calls++; active++; peak = Math.max(peak, active);
      try {
        if (invoke) return await invoke(input, options.signal);
        await setTimeout(10);
        return response(JSON.parse(String(input.messages[1]?.content)));
      } finally { active--; }
    } } } }),
    createInteractionWorker({ tools: adapter.tools, output: { async deliver(input, context) {
      delivered++; assert.equal(active, 0, "No summary delivery while a source model is running");
      if (rejectDelivery) return { deliveryId: input.deliveryId, status: "rejected", error: { code: "SINK_REJECTED", message: "Delivery rejected" } };
      return adapter.output.deliver(input, context);
    } } }),
  ] });
  return { directory, input, adapter, runtime, metrics: () => ({ calls, active, peak, delivered }), async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("parallel Graph overlaps independent orders within the selected concurrency and persists each result", async () => {
  for (const concurrency of [1, 2]) {
    const s = await setup(4);
    try {
      const before = structuredClone(s.input);
      const result = await runParallel(s.runtime, s.input, { concurrency });
      assert.equal(s.metrics().peak, concurrency);
      assert.equal(s.metrics().calls, 4);
      assert.equal(s.metrics().delivered, 0);
      assert.deepEqual(result.orders.map(row => row.sourceId), s.input.sources.map(source => source.id));
      for (const row of result.orders) assert.deepEqual(await readJson(s.adapter.pathFor(s.input.id, row.sourceId)), row);
      assert.deepEqual(s.input, before);
    } finally { await s.close(); }
  }
});

test("summary waits for successful artifacts and deterministically totals their persisted contents", async () => {
  const s = await setup();
  try {
    const result = await runSummary(s.runtime, s.input, { concurrency: 3 });
    const report = await readJson(join(s.adapter.batchDirectory(s.input.id), "report.json")) as OrderReport;
    assert.equal(report.status, "completed");
    assert.deepEqual(report.totals, { orders: 3, quantity: 6, totalCents: 600 });
    assert.deepEqual(result.report, report);
    assert.deepEqual(await readJson(join(s.adapter.batchDirectory(s.input.id), "delivery.json")), { deliveryId: s.input.id, report });
    assert.equal(s.metrics().delivered, 1);
    assert.equal(s.metrics().peak, 3);
  } finally { await s.close(); }
});

test("partial failures retain successful tasks, ordered failures and totals excluding failed sources", async () => {
  const s = await setup(4);
  try {
    await rm(s.input.sources[0]!.path);
    await writeFile(s.input.sources[2]!.path, "");
    const result = await runPartial(s.runtime, s.input);
    assert.deepEqual(result.orders.map(row => row.sourceId), ["order-1", "order-3"]);
    assert.deepEqual(result.failures.map(({ sourceId, code }) => ({ sourceId, code })), [
      { sourceId: "order-0", code: "SOURCE_NOT_FOUND" }, { sourceId: "order-2", code: "EMPTY_SOURCE" },
    ]);
    assert.equal(result.report.status, "partial");
    assert.deepEqual(result.report.totals, { orders: 2, quantity: 6, totalCents: 600 });
    assert.equal(s.metrics().calls, 2);
    for (const row of result.orders) assert.deepEqual(await readJson(s.adapter.pathFor(s.input.id, row.sourceId)), row);
    await assert.rejects(readFile(s.adapter.pathFor(s.input.id, "order-0")), { code: "ENOENT" });
  } finally { await s.close(); }
});

test("malformed, truncated and failed model responses preserve siblings without reporting invented orders", async () => {
  for (const scenario of ["malformed", "truncated", "failed"] as const) {
    const s = await setup(2, async input => {
      const value = JSON.parse(String(input.messages[1]?.content));
      if (value.code !== "CODE-0") return response(value);
      if (scenario === "failed") throw new Error("Provider unavailable");
      if (scenario === "malformed") return response({ ...value, quantity: -1 });
      return { ...response(value), finishReason: "length" };
    });
    try {
      const result = await runPartial(s.runtime, s.input);
      assert.equal(result.report.status, "partial");
      assert.deepEqual(result.orders.map(row => row.code), ["CODE-1"]);
      assert.equal(result.failures[0]?.code, scenario === "failed" ? "MODEL_FAILED" : "INVALID_MODEL_OUTPUT");
      assert.equal(s.metrics().delivered, 1);
    } finally { await s.close(); }
  }
});

test("all-failed and empty batches deliver explicit failed or empty-completed reports without model calls", async () => {
  for (const count of [0, 2]) {
    const s = await setup(count);
    try {
      for (const source of s.input.sources) await rm(source.path);
      const result = await runPartial(s.runtime, s.input);
      assert.equal(result.report.status, count ? "failed" : "completed");
      assert.deepEqual(result.report.totals, { orders: 0, quantity: 0, totalCents: 0 });
      assert.equal(s.metrics().calls, 0);
      assert.equal(s.metrics().delivered, 1);
    } finally { await s.close(); }
  }
});

test("invalid source catalogs and concurrency fail before starting any business work", async () => {
  const s = await setup(1);
  try {
    for (const concurrency of [0, -1, 1.5, Infinity, NaN]) await assert.rejects(runParallel(s.runtime, s.input, { concurrency }), /Concurrency/);
    await assert.rejects(runSummary(s.runtime, { ...s.input, sources: [s.input.sources[0]!, s.input.sources[0]!] }), /unique/);
    await assert.rejects(runPartial(s.runtime, { ...s.input, sources: Array.from({ length: 9 }, (_, i) => ({ ...s.input.sources[0]!, id: `extra-${i}` })) }), /at most eight/);
    assert.equal(s.metrics().calls, 0); assert.equal(s.metrics().delivered, 0);
  } finally { await s.close(); }
});

test("model-proposed task IDs and dependencies create executable work and a persisted plan", async () => {
  const plan = { tasks: [
    { id: "finish", kind: "summary", dependsOn: ["read-b", "read-a"] },
    { id: "read-b", kind: "extract", sourceId: "order-1", dependsOn: [] },
    { id: "read-a", kind: "extract", sourceId: "order-0", dependsOn: [] },
  ] };
  const s = await setup(2, async input => String(input.messages[0]?.content).startsWith("Plan the requested") ? response(plan) : response(JSON.parse(String(input.messages[1]?.content))));
  try {
    const result = await runPlanning(s.runtime, { ...s.input, objective: "Read both orders and create a report" });
    assert.deepEqual(result.plan, plan);
    assert.deepEqual(await readJson(join(s.adapter.batchDirectory(s.input.id), "plan.json")), plan);
    assert.equal(result.report.status, "completed");
    assert.ok(result.output["save:read-a"]);
    assert.ok(result.output["save:read-b"]);
    assert.ok(result.output["join:finish"]);
    assert.equal(s.metrics().calls, 3);
  } finally { await s.close(); }
});

test("planning rejects unknown operations, missing or repeated sources, bogus dependencies and cycles", async () => {
  const s = await setup(2);
  const good = { tasks: [
    { id: "a", kind: "extract", sourceId: "order-0", dependsOn: [] as string[] },
    { id: "b", kind: "extract", sourceId: "order-1", dependsOn: [] as string[] },
    { id: "c", kind: "summary", dependsOn: ["a", "b"] },
  ] };
  try {
    const cases: unknown[] = [null, { tasks: [] }];
    for (const mutate of [
      (p: typeof good) => { p.tasks[0]!.kind = "shell"; },
      (p: typeof good) => { p.tasks[0]!.sourceId = "unknown"; },
      (p: typeof good) => { p.tasks[1]!.sourceId = "order-0"; },
      (p: typeof good) => { p.tasks[1]!.id = "a"; },
      (p: typeof good) => { p.tasks[0]!.dependsOn = ["c"]; },
      (p: typeof good) => { p.tasks[2]!.dependsOn = ["a"]; },
      (p: typeof good) => { p.tasks[2]!.dependsOn = ["a", "nope"]; },
      (p: typeof good) => { p.tasks[2]!.dependsOn = ["a", "a"]; },
    ]) { const copy = structuredClone(good); mutate(copy); cases.push(copy); }
    for (const invalid of cases) assert.throws(() => validatePlan(invalid, s.input));
    assert.equal(s.metrics().calls, 0);
  } finally { await s.close(); }
});

test("invalid model planning output starts no source task and writes no plan or report", async () => {
  const s = await setup(2, async () => response({ tasks: [] }));
  try {
    await assert.rejects(runPlanning(s.runtime, { ...s.input, objective: "Process both" }), /cover every source/);
    assert.equal(s.metrics().calls, 1);
    await assert.rejects(readFile(join(s.adapter.batchDirectory(s.input.id), "plan.json")), { code: "ENOENT" });
    await assert.rejects(readFile(s.adapter.pathFor(s.input.id, "order-0")), { code: "ENOENT" });
  } finally { await s.close(); }
});

test("strict graphs stop reporting on failure; output rejection is not reported as successful delivery", async () => {
  const strict = await setup(2);
  try {
    await rm(strict.input.sources[0]!.path);
    await assert.rejects(runSummary(strict.runtime, strict.input, { concurrency: 1 }), /source was not found/);
    assert.equal(strict.metrics().calls, 0);
    assert.equal(strict.metrics().delivered, 0);
  } finally { await strict.close(); }
  const rejected = await setup(2, undefined, true);
  try {
    await assert.rejects(runSummary(rejected.runtime, rejected.input), /delivery was not accepted/);
    const report = await readJson(join(rejected.adapter.batchDirectory(rejected.input.id), "report.json")) as OrderReport;
    assert.equal(report.successes.length, 2);
    await assert.rejects(readFile(join(rejected.adapter.batchDirectory(rejected.input.id), "delivery.json")), { code: "ENOENT" });
  } finally { await rejected.close(); }
});

test("artifact retries are idempotent and conflicting existing records survive partial failure", async () => {
  const s = await setup(2);
  try {
    const first = await runSummary(s.runtime, s.input);
    const second = await runSummary(s.runtime, s.input);
    assert.deepEqual(second.report, first.report);
    // A new attempt cannot overwrite a completed order with changed source contents.
    await writeFile(s.input.sources[0]!.path, JSON.stringify({ code: "CHANGED", quantity: 5, unitPriceCents: 100 }));
    await assert.rejects(runSummary(s.runtime, s.input));
    assert.equal((await readJson(s.adapter.pathFor(s.input.id, "order-0")) as { code: string }).code, "CODE-0");
  } finally { await s.close(); }
});

test("cancellation drains all started tasks and does not turn cancellation into a partial success report", async () => {
  let started = 0;
  const controller = new AbortController();
  const s = await setup(2, async (_input, signal) => {
    started++;
    if (started === 2) controller.abort(new Error("stop task"));
    await setTimeout(5000, undefined, { signal });
    throw new Error("Unreachable");
  });
  try {
    await assert.rejects(runPartial(s.runtime, s.input, { signal: controller.signal }), /stop task/);
    assert.equal(started, 2);
    assert.equal(s.metrics().active, 0);
    assert.equal(s.metrics().delivered, 0);
    await assert.rejects(readFile(join(s.adapter.batchDirectory(s.input.id), "report.json")), { code: "ENOENT" });
  } finally { await s.close(); }
});
