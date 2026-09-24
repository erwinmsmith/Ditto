/** Task acceptance uses actual configured HTTP inference, filesystem tools and reopened artifacts. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile, loop } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createBriefFiles, readJson, type BriefReport, type RoundRecord } from "../examples/_shared/tools/brief-files.ts";
import { createFixture, type Mode } from "../examples/control-flow/iteration/fixtures.ts";
import { runBounded, boundedRound } from "../examples/control-flow/iteration/bounded-loop.ts";
import { runAdaptive } from "../examples/control-flow/iteration/adaptive-loop.ts";
import { runImprovement } from "../examples/control-flow/iteration/improvement.ts";
import { runRetrieval } from "../examples/control-flow/iteration/retrieval.ts";
import { runGoalCheck } from "../examples/control-flow/iteration/goal-check.ts";
import { runStopConditions } from "../examples/control-flow/iteration/stop-conditions.ts";
import { advance, begin, type Input, type State } from "../examples/control-flow/iteration/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-iteration-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-iteration-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider], "Select a configured provider");
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined);
assert.ok(modelName);
const model = { provider, model: modelName };
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
interface Span { node: string; graphId?: string; nodeId?: string; runId?: string; start: number; end?: number; status?: string; executionId?: unknown; usage?: unknown }
const runners = { bounded: runBounded, adaptive: runAdaptive, improvement: runImprovement, retrieval: runRetrieval, goal: runGoalCheck, stop: runStopConditions };
const scenarios: { name: string; mode: Mode; variant?: string; limits?: Partial<Input>; reason?: string; calls?: number }[] = [
  { name: "fixed-rounds", mode: "bounded", reason: "goal", calls: 3 },
  { name: "adaptive-source-fallback", mode: "adaptive", reason: "goal", calls: 10 },
  { name: "improve-existing-draft", mode: "improvement", reason: "goal", calls: 3 },
  { name: "retrieve-then-compose", mode: "retrieval", reason: "goal", calls: 4 },
  { name: "goal-final-defect", mode: "goal", reason: "goal", calls: 1 },
  { name: "goal-already-complete", mode: "goal", variant: "complete", limits: { maxRounds: 0, modelCallBudget: 0 }, reason: "goal", calls: 0 },
  { name: "empty-goal", mode: "goal", variant: "empty", reason: "goal", calls: 0 },
  { name: "budget-preserves-revision", mode: "stop", limits: { modelCallBudget: 1 }, reason: "budget", calls: 1 },
  { name: "zero-budget", mode: "stop", limits: { modelCallBudget: 0 }, reason: "budget", calls: 0 },
  { name: "round-limit-preserves-revision", mode: "stop", limits: { maxRounds: 1 }, reason: "round-limit", calls: 1 },
  { name: "zero-rounds", mode: "stop", limits: { maxRounds: 0 }, reason: "round-limit", calls: 0 },
  { name: "blocked-before-work", mode: "stop", variant: "no-sources", reason: "blocked", calls: 0 },
  { name: "blocked-after-real-lookup", mode: "retrieval", variant: "missing-source", reason: "blocked", calls: 1 },
  { name: "evidence-is-not-a-finished-brief", mode: "retrieval", limits: { modelCallBudget: 3 }, reason: "budget", calls: 3 },
  { name: "adaptive-budget-reserves-next-call", mode: "adaptive", limits: { modelCallBudget: 1 }, reason: "budget", calls: 1 },
  { name: "native-hard-limit", mode: "bounded", variant: "hard-limit", calls: 1 },
  { name: "pre-cancelled-task", mode: "bounded", variant: "cancel", calls: 0 },
];
const results: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const caseDirectory = join(directory, scenario.name); await mkdir(caseDirectory);
  const inputDirectory = join(caseDirectory, "input"), outputDirectory = join(caseDirectory, "output");
  const { spec, expected } = await createFixture(inputDirectory, scenario.mode);
  if (scenario.variant === "complete") spec.initialDraft = { ...expected };
  if (scenario.variant === "empty") { spec.required = []; spec.initialDraft = {}; spec.initialEvidence = []; }
  if (scenario.variant === "no-sources") { spec.catalog = []; spec.initialEvidence = []; }
  if (scenario.variant === "missing-source") await rm(join(inputDirectory, "code-source.json"));
  await writeFile(join(inputDirectory, "spec.json"), JSON.stringify(spec, null, 2));
  const adapter = createBriefFiles({ inputDirectory, outputDirectory }), spans: Span[] = [];
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
    observed(createInferWorker()), observed(createInteractionWorker({ tools: adapter.tools })),
  ] });
  const result: Record<string, unknown> = { name: scenario.name, status: "failed", directory: caseDirectory };
  let report: BriefReport | undefined;
  try {
    const input = { model, ...scenario.limits };
    if (scenario.variant === "hard-limit") {
      const initial = await begin(runtime, input, {});
      await assert.rejects(runtime.loop(loop({ graph: boundedRound, maxIterations: 1,
        bind: (state: State) => ({ state, model }), update: advance, done: () => false,
      }), initial), /Loop iteration limit reached/);
      const record = await readJson(join(outputDirectory, "rounds/1.json")) as RoundRecord;
      assert.equal(record.snapshot.issues.length, 2);
      await assert.rejects(readFile(join(outputDirectory, "result.json")), { code: "ENOENT" });
      result.expectedError = "Loop iteration limit reached";
    } else if (scenario.variant === "cancel") {
      await assert.rejects(runBounded(runtime, input, { signal: AbortSignal.abort(new Error("cancel experiment")) }), /cancel experiment/);
      await assert.rejects(readFile(join(outputDirectory, "state.json")), { code: "ENOENT" });
      result.expectedError = "cancel experiment";
    } else {
      report = await runners[scenario.mode](runtime, input);
      assert.equal(report.reason, scenario.reason);
      assert.equal(report.status, scenario.reason === "goal" ? "completed" : "stopped");
      assert.equal(report.modelCalls, spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length);
      assert.ok(report.rounds <= (input.maxRounds ?? 24)); assert.ok(report.modelCalls <= (input.modelCallBudget ?? 24));
      if (report.status === "completed") assert.deepEqual(report.snapshot.draft, scenario.variant === "empty" ? {} : expected);
      const records = await Promise.all(Array.from({ length: report.rounds }, (_, i) => readJson(join(outputDirectory, `rounds/${i + 1}.json`)) as Promise<RoundRecord>));
      assert.deepEqual(records.map(record => record.round), Array.from({ length: report.rounds }, (_, i) => i + 1));
      if (records.length) assert.deepEqual(records.at(-1)!.snapshot, report.snapshot);
      if (scenario.name === "adaptive-source-fallback") {
        const plans = records.filter(record => record.action === "plan");
        assert.deepEqual(plans[0]!.next, { kind: "search", field: "code", sourceId: "stale-source" });
        assert.deepEqual(plans[1]!.next, { kind: "search", field: "code", sourceId: "code-source" });
        assert.deepEqual(plans[2]!.next, { kind: "repair", field: "code" });
        assert.equal(report.snapshot.attempts[0]!.found, false);
        for (const [index, record] of records.entries()) {
          if (record.next) {
            const expectedGraph = record.next.kind === "search" ? "brief-search" : "brief-adaptive-repair";
            const next = records[index + 1]!;
            assert.equal(next.action, record.next.kind === "search" ? "search" : expectedGraph);
            assert.ok(spans.some(span => span.graphId === expectedGraph));
          }
        }
      }
      if (["fixed-rounds", "improve-existing-draft"].includes(scenario.name)) assert.deepEqual(records.map(record => record.snapshot.issues.length), [2, 1, 0]);
      if (scenario.mode === "retrieval" && scenario.reason === "goal") {
        assert.deepEqual(records.map(record => record.snapshot.missing.length), [2, 1, 0, 0]);
        assert.ok(records.slice(0, 3).every(record => Object.keys(record.snapshot.draft).length === 0));
      }
      if (scenario.name === "evidence-is-not-a-finished-brief") { assert.equal(report.snapshot.missing.length, 0); assert.equal(report.snapshot.complete, false); }
      if (scenario.name === "adaptive-budget-reserves-next-call") { assert.equal(report.rounds, 2); assert.equal(report.snapshot.attempts.length, 1); }
      if (["budget-preserves-revision", "round-limit-preserves-revision"].includes(scenario.name)) assert.deepEqual(report.snapshot.draft, { code: expected.code });
      if (scenario.variant === "missing-source") assert.equal(report.snapshot.attempts[0]!.found, false);
      if (report.snapshot.revision) assert.deepEqual(await readJson(join(outputDirectory, `revisions/${report.snapshot.revision}.json`)), report.snapshot.draft);
      result.report = report;
    }
    assert.equal(spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length, scenario.calls);
    assert.ok(spans.every(span => span.end !== undefined));
    await runtime.close();
    if (report) {
      // Reopen without the Runtime or prior adapter and verify every persisted source/draft value.
      const reopened = createBriefFiles({ inputDirectory, outputDirectory });
      assert.deepEqual(await reopened.inspect(), report.snapshot);
      assert.deepEqual(await readJson(join(outputDirectory, "result.json")), report);
      const markdown = await readFile(join(outputDirectory, "brief.md"), "utf8");
      for (const value of Object.values(report.snapshot.draft)) assert.ok(markdown.includes(value));
      result.reopened = true;
    }
    result.status = "passed";
  } catch (error) { result.error = error instanceof Error ? error.message : "Unknown experiment failure"; }
  finally {
    await runtime.close();
    Object.assign(result, { modelCalls: spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length, spans });
    results.push(result);
    await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model: modelName, directory, results }, null, 2));
    console.log(JSON.stringify({ name: scenario.name, status: result.status, modelCalls: result.modelCalls, ...(result.error ? { error: result.error } : {}) }));
  }
}
const failed = results.filter(result => result.status !== "passed");
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((sum, result) => sum + Number(result.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2));
if (failed.length) throw new Error(`${failed.length} iteration task experiments failed`);
