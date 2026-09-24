import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDitto, loop } from "@ditto/core/runtime";
import { createInferWorker, type SampleInput, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createBriefFiles, readJson, validateAction, type RoundRecord, type Snapshot } from "../examples/_shared/tools/brief-files.ts";
import { createFixture, type Mode } from "../examples/control-flow/iteration/fixtures.ts";
import { runBounded, boundedRound } from "../examples/control-flow/iteration/bounded-loop.ts";
import { runAdaptive } from "../examples/control-flow/iteration/adaptive-loop.ts";
import { runImprovement } from "../examples/control-flow/iteration/improvement.ts";
import { runRetrieval } from "../examples/control-flow/iteration/retrieval.ts";
import { runGoalCheck } from "../examples/control-flow/iteration/goal-check.ts";
import { runStopConditions } from "../examples/control-flow/iteration/stop-conditions.ts";
import { advance, begin, type State } from "../examples/control-flow/iteration/shared.ts";
const model = { provider: "unit", model: "unit" };
const response = (value: unknown): SampleOutput => ({ message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop" });
function answer(input: SampleInput): SampleOutput {
  const body = JSON.parse(String(input.messages[1]!.content));
  if (body.fields) return response({ patches: Object.fromEntries(body.fields.map((field: string) => [field, body.evidence[field].value])) });
  const repair = !String(input.messages[0]!.content).includes("Search only") ? undefined : body.issues.find((field: string) => body.evidence[field]);
  if (repair && String(input.messages[0]!.content).includes('"kind":"repair"')) return response({ kind: "repair", field: repair });
  const field = body.missing[0];
  return response({ kind: "search", field, sourceId: body.candidates[field][0] });
}
async function setup(mode: Mode = "bounded", invoke: (input: SampleInput, call: number) => Promise<SampleOutput> = async input => answer(input)) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-iteration-test-"));
  const inputDirectory = join(directory, "input"), outputDirectory = join(directory, "output");
  const fixture = await createFixture(inputDirectory, mode);
  const adapter = createBriefFiles({ inputDirectory, outputDirectory });
  let calls = 0;
  const runtime = createDitto({ sandbox: { tools: adapter.tools.map(tool => tool.name) }, workers: [
    createInferWorker({ providers: { unit: { async invoke(input) { return invoke(input, ++calls); } } } }),
    createInteractionWorker({ tools: adapter.tools }),
  ] });
  return { ...fixture, adapter, directory, inputDirectory, outputDirectory, runtime, calls: () => calls,
    async saveSpec() { await writeFile(join(inputDirectory, "spec.json"), JSON.stringify(fixture.spec)); },
    async records(count: number) { return Promise.all(Array.from({ length: count }, (_, i) => readJson(join(outputDirectory, `rounds/${i + 1}.json`)) as Promise<RoundRecord>)); },
    async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("bounded Loop persists three checked revisions and survives reopening its file adapter", async () => {
  const s = await setup();
  try {
    const result = await runBounded(s.runtime, { model });
    assert.equal(result.reason, "goal"); assert.equal(result.rounds, 3); assert.equal(s.calls(), 3);
    assert.deepEqual(result.snapshot.draft, s.expected);
    assert.deepEqual((await s.records(3)).map(row => row.snapshot.issues.length), [2, 1, 0]);
    await s.runtime.close();
    const reopened = createBriefFiles({ inputDirectory: s.inputDirectory, outputDirectory: s.outputDirectory });
    assert.deepEqual(await reopened.inspect(), result.snapshot);
    assert.deepEqual(await readJson(join(s.outputDirectory, "result.json")), result);
    assert.ok((await readFile(join(s.outputDirectory, "brief.md"), "utf8")).includes(s.expected.code));
  } finally { await s.close(); }
});

test("adaptive Loop replaces a failed search plan, selects actual search/repair graphs and completes", async () => {
  const s = await setup("adaptive");
  try {
    const result = await runAdaptive(s.runtime, { model });
    assert.deepEqual(result.snapshot.draft, s.expected); assert.equal(result.reason, "goal");
    const records = await s.records(result.rounds), plans = records.filter(row => row.action === "plan");
    assert.deepEqual(plans[0]!.next, { kind: "search", field: "code", sourceId: "stale-source" });
    assert.deepEqual(plans[1]!.next, { kind: "search", field: "code", sourceId: "code-source" });
    assert.deepEqual(plans[2]!.next, { kind: "repair", field: "code" });
    assert.equal(result.snapshot.attempts[0]!.found, false);
    assert.equal(result.modelCalls, s.calls()); assert.equal(result.rounds, 14);
  } finally { await s.close(); }
});

test("iterative improvement preserves correct fields and replaces incorrect persisted draft values", async () => {
  const s = await setup("improvement");
  try {
    s.spec.initialDraft.code = s.expected.code; await s.saveSpec();
    const result = await runImprovement(s.runtime, { model });
    assert.equal(result.rounds, 2); assert.deepEqual(result.snapshot.draft, s.expected);
    assert.ok((await s.records(2)).every(row => row.snapshot.draft.code === s.expected.code));
    assert.deepEqual(await readJson(join(s.outputDirectory, "revisions/0.json")), s.spec.initialDraft);
  } finally { await s.close(); }
});

test("iterative retrieval accumulates missing evidence before composing a checked artifact", async () => {
  const s = await setup("retrieval");
  try {
    const result = await runRetrieval(s.runtime, { model });
    const records = await s.records(result.rounds);
    assert.deepEqual(records.map(row => row.snapshot.missing.length), [2, 1, 0, 0]);
    assert.deepEqual(records.slice(0, 3).map(row => row.snapshot.draft), [{}, {}, {}]);
    assert.deepEqual(result.snapshot.draft, s.expected); assert.equal(result.modelCalls, 4);
  } finally { await s.close(); }
});

test("goal check stops immediately for valid input, otherwise exits after the last actual defect", async () => {
  for (const complete of [false, true]) {
    const s = await setup("goal");
    try {
      if (complete) { s.spec.initialDraft = { ...s.expected }; await s.saveSpec(); }
      const result = await runGoalCheck(s.runtime, { model, maxRounds: complete ? 0 : 10, modelCallBudget: complete ? 0 : 10 });
      assert.equal(result.reason, "goal"); assert.equal(result.rounds, complete ? 0 : 1); assert.equal(s.calls(), result.rounds);
    } finally { await s.close(); }
  }
});

test("stop checks preserve partial artifacts and enforce zero/nonzero budgets and round limits", async () => {
  for (const [options, reason, count] of [
    [{ modelCallBudget: 0 }, "budget", 0], [{ modelCallBudget: 1 }, "budget", 1],
    [{ maxRounds: 0 }, "round-limit", 0], [{ maxRounds: 1 }, "round-limit", 1],
  ] as const) {
    const s = await setup();
    try {
      const result = await runStopConditions(s.runtime, { model, ...options });
      assert.equal(result.status, "stopped"); assert.equal(result.reason, reason); assert.equal(s.calls(), count);
      assert.equal(result.snapshot.issues.length, 3 - count); assert.equal(result.rounds, count);
      assert.deepEqual(await readJson(join(s.outputDirectory, "result.json")), result);
    } finally { await s.close(); }
  }
});

test("evidence coverage alone is not completion and adaptive free search can use a reserved plan", async () => {
  const r = await setup("retrieval"), a = await setup("adaptive");
  try {
    const retrieved = await runRetrieval(r.runtime, { model, modelCallBudget: 3 });
    assert.equal(retrieved.reason, "budget"); assert.equal(retrieved.snapshot.missing.length, 0); assert.equal(retrieved.snapshot.complete, false);
    const adapted = await runAdaptive(a.runtime, { model, modelCallBudget: 1 });
    assert.equal(adapted.reason, "budget"); assert.equal(adapted.rounds, 2); assert.equal(adapted.modelCalls, 1);
    assert.equal(adapted.snapshot.attempts.length, 1);
  } finally { await r.close(); await a.close(); }
});

test("missing sources end with blocked state without fabricating evidence", async () => {
  const s = await setup("retrieval");
  try {
    await rm(join(s.inputDirectory, "code-source.json"));
    const result = await runRetrieval(s.runtime, { model });
    assert.equal(result.reason, "blocked"); assert.equal(result.status, "stopped"); assert.equal(s.calls(), 1);
    assert.deepEqual(result.snapshot.evidence, {}); assert.equal(result.snapshot.attempts[0]!.found, false);
  } finally { await s.close(); }
});

test("independent goal checker rejects plausible but incorrect values and ignores model completion claims", async () => {
  const s = await setup("goal", async () => response({ patches: { deadline: "wrong" }, complete: true }));
  try {
    const result = await runGoalCheck(s.runtime, { model, maxRounds: 2 });
    assert.equal(result.reason, "round-limit"); assert.equal(result.snapshot.complete, false); assert.equal(result.snapshot.draft.deadline, "wrong");
  } finally { await s.close(); }
});

test("malformed, truncated, failed and out-of-scope model actions do not produce a completion report", async () => {
  for (const kind of ["malformed", "truncated", "failed", "invalid-plan"] as const) {
    const s = await setup(kind === "invalid-plan" ? "adaptive" : "bounded", async input => {
      if (kind === "failed") throw new Error("Provider unavailable");
      if (kind === "truncated") return { ...answer(input), finishReason: "length" };
      return response(kind === "invalid-plan" ? { kind: "search", field: "code", sourceId: "unlisted" } : { patches: { alien: "value" } });
    });
    try {
      await assert.rejects((kind === "invalid-plan" ? runAdaptive : runBounded)(s.runtime, { model }));
      await assert.rejects(readFile(join(s.outputDirectory, "result.json")), { code: "ENOENT" });
    } finally { await s.close(); }
  }
});

test("native Loop hard guard still rejects when an application never declares done", async () => {
  const s = await setup();
  try {
    const initial = await begin(s.runtime, { model }, {});
    await assert.rejects(s.runtime.loop(loop({ graph: boundedRound, maxIterations: 1,
      bind: (state: State) => ({ state, model }), update: advance, done: () => false,
    }), initial), /Loop iteration limit reached/);
    assert.equal(s.calls(), 1); await assert.rejects(readFile(join(s.outputDirectory, "result.json")), { code: "ENOENT" });
  } finally { await s.close(); }
});

test("source changes invalidate evidence, reused directories fail, and invalid limits perform no work", async () => {
  const s = await setup();
  try {
    for (const maxRounds of [-1, 1.5, Infinity, 101]) await assert.rejects(runBounded(s.runtime, { model, maxRounds }), /integer/);
    await begin(s.runtime, { model }, {});
    await assert.rejects(begin(s.runtime, { model }, {}));
    await writeFile(join(s.inputDirectory, "code-source.json"), JSON.stringify({ facts: { code: "tampered" } }));
    await assert.rejects(s.adapter.inspect(), /Evidence source changed/); assert.equal(s.calls(), 0);
  } finally { await s.close(); }
});

test("pre-cancelled runs perform no work and active cancellation never starts another round", async () => {
  const controller = new AbortController();
  const s = await setup("bounded", async input => { controller.abort(new Error("cancel task")); return answer(input); });
  try {
    await assert.rejects(runBounded(s.runtime, { model }, { signal: AbortSignal.abort(new Error("already cancelled")) }), /already cancelled/);
    assert.equal(s.calls(), 0);
    await assert.rejects(runBounded(s.runtime, { model }, { signal: controller.signal }), /cancel task/);
    assert.equal(s.calls(), 1); await assert.rejects(readFile(join(s.outputDirectory, "result.json")), { code: "ENOENT" });
  } finally { await s.close(); }
});

test("plans cannot repeat a source or repair a field without evidence", () => {
  const snapshot = { missing: ["code"], issues: ["code"], evidence: {}, catalog: [{ id: "source", fields: ["code"] }], attempts: [{ field: "code", sourceId: "source", found: false }] } as unknown as Snapshot;
  assert.throws(() => validateAction({ kind: "search", field: "code", sourceId: "source" }, snapshot));
  assert.throws(() => validateAction({ kind: "repair", field: "code" }, snapshot));
});
