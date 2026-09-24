/** Real task acceptance: original files, overlapping HTTP inference, durable artifacts and failure retention. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createOrderFiles, readJson, type SavedOrder, type OrderReport } from "../examples/_shared/tools/order-files.ts";
import { runParallel } from "../examples/control-flow/parallel/concurrency-limit.ts";
import { runSummary } from "../examples/control-flow/parallel/fan-out-fan-in.ts";
import { runPlanning } from "../examples/control-flow/parallel/planning.ts";
import { runPartial } from "../examples/control-flow/parallel/partial-results.ts";
import type { BatchInput, Source } from "../examples/control-flow/parallel/shared.ts";

const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-parallel-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-parallel-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider], "Select a configured provider");
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined);
assert.ok(modelName);
const model = { provider, model: modelName };
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const inputDirectory = join(directory, "input"), outputDirectory = join(directory, "output");
await mkdir(inputDirectory);
const adapter = createOrderFiles({ inputDirectory, outputDirectory });
interface Span { node: string; nodeId?: string; graphId?: string; runId?: string; start: number; end?: number; status?: string; executionId?: unknown; usage?: unknown }
let spans: Span[] = [];
// Observe actual WorkerExecutor calls without replacing handlers or configured HTTP providers.
function observed(definition: WorkerDefinition): WorkerDefinition {
  return { ...definition, instantiate() {
    const worker = definition.instantiate();
    return { async execute(node, input, context) {
      const span: Span = { node, ...context.execution, start: performance.now() }; spans.push(span);
      try {
        const result = await worker.execute(node, input, context);
        span.status = "returned";
        if (result && typeof result === "object" && "status" in result) span.status = String(result.status);
        if (result && typeof result === "object" && "executionId" in result) {
          span.executionId = result.executionId;
          if ("output" in result && result.output && typeof result.output === "object" && "usage" in result.output) span.usage = result.output.usage;
        }
        return result;
      } catch (error) { span.status = "threw"; throw error; }
      finally { span.end = performance.now(); }
    }, async dispose() { await worker.dispose?.(); } };
  } };
}
const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: adapter.tools.map(tool => tool.name) }, workers: [
  observed(createInferWorker()), observed(createInteractionWorker({ tools: adapter.tools, output: adapter.output })),
] });
function maximum(rows: Span[]): number {
  const events = rows.flatMap(row => [{ time: row.start, delta: 1 }, { time: row.end!, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0, maximum = 0;
  for (const event of events) { active += event.delta; maximum = Math.max(maximum, active); }
  assert.equal(active, 0, "All started operations must settle");
  return maximum;
}
function modelSpans() { return spans.filter(span => span.node === "INFER.REASONING.SAMPLE"); }
function assertJoined() {
  const saves = spans.filter(span => span.nodeId?.startsWith("save:") || span.nodeId === "saved");
  const joins = spans.filter(span => span.nodeId?.startsWith("join:") || span.graphId === "partial-order-report");
  assert.ok(joins.length);
  for (const save of saves) assert.ok(save.end! <= joins[0]!.start, "Report must wait for all started branch saves");
}
async function fixture(id: string, count: number): Promise<{ input: BatchInput; expected: SavedOrder[] }> {
  const sources: Source[] = [], expected: SavedOrder[] = [];
  for (let index = 0; index < count; index++) {
    const sourceId = `source-${index}`, code = `ORDER-${randomBytes(5).toString("hex")}`;
    const quantity = randomInt(1, 12), unitPriceCents = randomInt(50, 2000);
    const text = `Order code ${code}. Quantity ${quantity}. Unit price ${unitPriceCents} cents.\n`;
    const path = join(inputDirectory, `${id}-${sourceId}.txt`);
    await writeFile(path, text);
    sources.push({ id: sourceId, path, description: `Independent order document ${index}` });
    expected.push({ sourceId, sourceSha256: createHash("sha256").update(text).digest("hex"), code, quantity, unitPriceCents, totalCents: quantity * unitPriceCents });
  }
  await writeFile(join(inputDirectory, `${id}.request.json`), JSON.stringify({ id, sources }, null, 2));
  const request = await readJson(join(inputDirectory, `${id}.request.json`)) as { id: string; sources: Source[] };
  return { input: { ...request, model }, expected };
}
const retained = new Map<string, OrderReport>();
async function orders(id: string, expected: SavedOrder[]) {
  for (const item of expected) assert.deepEqual(await readJson(adapter.pathFor(id, item.sourceId)), item);
}
async function report(id: string, expected: SavedOrder[], failures: { sourceId: string; code: string }[] = []) {
  await orders(id, expected);
  const actual = await readJson(join(adapter.batchDirectory(id), "report.json")) as OrderReport;
  assert.equal(actual.status, failures.length ? expected.length ? "partial" : "failed" : "completed");
  assert.deepEqual([...actual.successes].sort((a,b) => a.sourceId.localeCompare(b.sourceId)), [...expected].sort((a,b) => a.sourceId.localeCompare(b.sourceId)));
  assert.deepEqual(actual.failures.map(({ sourceId, code }) => ({ sourceId, code })), failures);
  assert.ok(actual.failures.every(item => item.message.trim()));
  assert.deepEqual(actual.totals, { orders: expected.length, quantity: expected.reduce((n, row) => n + row.quantity, 0), totalCents: expected.reduce((n, row) => n + row.quantity * row.unitPriceCents, 0) });
  assert.deepEqual(await readJson(join(adapter.batchDirectory(id), "delivery.json")), { deliveryId: id, report: actual });
  retained.set(id, actual);
  return actual;
}
const results: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
async function check(name: string, run: () => Promise<Record<string, unknown>>) {
  spans = []; const start = performance.now();
  console.log(JSON.stringify({ name, event: "started" }));
  const result: Record<string, unknown> = { name, status: "failed" };
  try { Object.assign(result, await run()); result.status = "passed"; }
  catch (error) { result.error = error instanceof Error ? error.message : "Unknown failure"; }
  finally {
    Object.assign(result, { durationMs: performance.now() - start, maxActiveNodes: maximum(spans), maxActiveModels: maximum(modelSpans()), modelCalls: modelSpans().length, spans: [...spans] });
    results.push(result);
    await writeFile(values.report!, JSON.stringify({ startedAt, checkedAt: new Date().toISOString(), provider, model: modelName, directory,
      passed: results.filter(row => row.status === "passed").length, failed: results.filter(row => row.status !== "passed").length, results }, null, 2) + "\n");
    console.log(JSON.stringify({ ...result, spans: undefined }));
  }
}
try {
  for (const concurrency of [1, 2]) await check(`execution-concurrency-${concurrency}`, async () => {
    const { input, expected } = await fixture(`execution-${concurrency}`, 4);
    const result = await runParallel(runtime, input, { concurrency });
    assert.deepEqual(result.orders, expected); await orders(input.id, expected);
    assert.equal(maximum(modelSpans()), concurrency, "Actual HTTP model operations must overlap up to the configured limit");
    assert.ok(maximum(spans) <= concurrency);
    return { batchId: input.id, retainedOrders: expected.length, expectedConcurrency: concurrency };
  });
  await check("summary-after-all-branches", async () => {
    const { input, expected } = await fixture("summary", 3);
    await runSummary(runtime, input, { concurrency: 3 });
    assertJoined(); assert.ok(maximum(modelSpans()) >= 2);
    return { batchId: input.id, report: await report(input.id, expected) };
  });
  for (const count of [2, 4]) await check(`automatic-plan-${count}-sources`, async () => {
    const { input, expected } = await fixture(`planning-${count}`, count);
    const result = await runPlanning(runtime, { ...input, objective: "Independently extract all order documents and then combine their quantities and revenue into a single report." }, { concurrency: 3 });
    assert.deepEqual(await readJson(join(adapter.batchDirectory(input.id), "plan.json")), result.plan);
    const extracts = result.plan.tasks.filter(task => task.kind === "extract");
    assert.deepEqual(extracts.map(task => task.sourceId).sort(), input.sources.map(source => source.id).sort());
    assert.ok(extracts.every(task => task.dependsOn.length === 0));
    for (const task of extracts) assert.ok(spans.some(span => span.nodeId === `save:${task.id}`), "Execution must use the model-proposed task IDs");
    const persisted = spans.find(span => span.graphId === "plan-parallel-orders" && span.nodeId === "persisted")!;
    assert.ok(spans.filter(span => span.nodeId?.startsWith("read:")).every(span => span.start >= persisted.end!));
    assertJoined(); assert.equal(modelSpans().length, count + 1);
    assert.ok(maximum(modelSpans()) >= 2);
    return { batchId: input.id, plan: result.plan, report: await report(input.id, expected) };
  });
  await check("partial-missing-source", async () => {
    const { input, expected } = await fixture("partial-missing", 3);
    const sources = input.sources.map((source, i) => i === 1 ? { ...source, path: join(inputDirectory, "missing.txt") } : source);
    await runPartial(runtime, { ...input, sources });
    assertJoined(); assert.ok(maximum(modelSpans()) >= 2);
    await assert.rejects(readFile(adapter.pathFor(input.id, "source-1")), { code: "ENOENT" });
    return { batchId: input.id, report: await report(input.id, expected.filter((_,i) => i !== 1), [{ sourceId: "source-1", code: "SOURCE_NOT_FOUND" }]) };
  });
  await check("partial-empty-source", async () => {
    const { input, expected } = await fixture("partial-empty", 3);
    await writeFile(input.sources[1]!.path, "  \n");
    await runPartial(runtime, input); assertJoined();
    assert.equal(modelSpans().length, 2);
    return { batchId: input.id, report: await report(input.id, expected.filter((_,i) => i !== 1), [{ sourceId: "source-1", code: "EMPTY_SOURCE" }]) };
  });
  await check("partial-real-model-invalid-record", async () => {
    const { input, expected } = await fixture("partial-invalid-record", 2);
    await writeFile(input.sources[0]!.path, "No order exists in this document. The order code, quantity and price are all missing.");
    await runPartial(runtime, input); assertJoined();
    assert.equal(modelSpans().length, 2);
    return { batchId: input.id, report: await report(input.id, expected.slice(1), [{ sourceId: "source-0", code: "INVALID_MODEL_OUTPUT" }]) };
  });
  await check("partial-artifact-conflict", async () => {
    const { input, expected } = await fixture("partial-conflict", 2);
    await mkdir(adapter.batchDirectory(input.id), { recursive: true });
    const previous = { preserved: "existing business artifact" };
    await writeFile(adapter.pathFor(input.id, "source-0"), JSON.stringify(previous));
    await runPartial(runtime, input); assertJoined();
    assert.deepEqual(await readJson(adapter.pathFor(input.id, "source-0")), previous);
    return { batchId: input.id, report: await report(input.id, expected.slice(1), [{ sourceId: "source-0", code: "ARTIFACT_CONFLICT" }]) };
  });
  await check("all-failed-report", async () => {
    const { input } = await fixture("all-failed", 2);
    await runPartial(runtime, { ...input, sources: input.sources.map(source => ({ ...source, path: join(inputDirectory, `missing-${source.id}`) })) });
    assert.equal(modelSpans().length, 0);
    return { batchId: input.id, report: await report(input.id, [], input.sources.map(source => ({ sourceId: source.id, code: "SOURCE_NOT_FOUND" }))) };
  });
  await check("empty-batch-report", async () => {
    const { input } = await fixture("empty-batch", 0);
    await runPartial(runtime, input); assert.equal(modelSpans().length, 0);
    return { batchId: input.id, report: await report(input.id, []) };
  });
  await check("strict-graph-stops-on-failure", async () => {
    const { input } = await fixture("strict-failure", 2);
    await writeFile(input.sources[0]!.path, "");
    await assert.rejects(runSummary(runtime, input, { concurrency: 1 }), /source is empty/);
    assert.equal(modelSpans().length, 0);
    await assert.rejects(readFile(join(adapter.batchDirectory(input.id), "report.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(adapter.batchDirectory(input.id), "delivery.json")), { code: "ENOENT" });
    return { batchId: input.id, successfulReport: false };
  });
  await runtime.close();
  await check("reopen-delivered-artifacts", async () => {
    const reopened = createOrderFiles({ inputDirectory, outputDirectory });
    for (const [id, expected] of retained) {
      assert.deepEqual(await readJson(join(reopened.batchDirectory(id), "report.json")), expected);
      assert.deepEqual(await readJson(join(reopened.batchDirectory(id), "delivery.json")), { deliveryId: id, report: expected });
      for (const success of expected.successes) assert.deepEqual(await readJson(reopened.pathFor(id, success.sourceId)), success);
    }
    return { reopenedReports: retained.size, directory: outputDirectory };
  });
} finally { await runtime.close(); }
assert.equal(results.length, 13);
if (results.some(row => row.status !== "passed")) process.exitCode = 1;
