import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDitto } from "@ditto/core/runtime";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker, type SampleInput, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { HumanReviewStore, digest, type HumanMode } from "../examples/_shared/tools/human-review-store.ts";
import { createFixture, reviewers } from "../examples/control-flow/human/fixtures.ts";
import { runApproval } from "../examples/control-flow/human/approval.ts";
import { runIntermediate } from "../examples/control-flow/human/intermediate.ts";
import { runEditContinue } from "../examples/control-flow/human/edit-and-continue.ts";
import { runReviewPublish } from "../examples/control-flow/human/review-publish.ts";
import { runEscalation } from "../examples/control-flow/human/escalation.ts";
import { executionGraph } from "../examples/control-flow/human/shared.ts";
const model = { provider: "unit", model: "unit" };
const response = (value: unknown): SampleOutput => ({ message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop" });
function answer(input: SampleInput): SampleOutput {
  const body = JSON.parse(String(input.messages[1]!.content));
  if (body.artifact) { const d = body.artifact.draft; return response({ releaseId: d.releaseId, date: d.date, title: d.title }); }
  const source = body[0].content.source;
  return response({ releaseId: source.releaseId, date: source.sources[0].date, title: source.title, body: `${source.releaseId}: ${source.change}` });
}
async function setup(mode: HumanMode = "approval", invoke = async (input: SampleInput) => answer(input)) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-human-test-")), source = await createFixture(directory, mode);
  let store = new HumanReviewStore(directory, reviewers), calls = 0, rejectDelivery = false;
  const openRuntime = () => createDitto({ sandbox: { tools: store.tools.map(tool => tool.name) }, workers: [
    createContextWorker(), createInferWorker({ providers: { unit: { async invoke(input) { calls++; return invoke(input); } } } }),
    createInteractionWorker({ tools: store.tools, output: { async deliver(input, context) {
      if (rejectDelivery) return { deliveryId: input.deliveryId, status: "rejected", error: { code: "INBOX_UNAVAILABLE", message: "Review inbox unavailable" } };
      return store.output.deliver(input, context);
    } } }),
  ] });
  let runtime = openRuntime(); await store.create("task", mode);
  return { directory, source, input: { id: "task", model }, get runtime() { return runtime; }, get store() { return store; }, calls: () => calls,
    rejectDelivery(value: boolean) { rejectDelivery = value; },
    decide(actor: string, choice: "approve" | "reject" = "approve") { const request = store.request(store.job("task").gateId!); return store.decide({ requestId: request.id, expectedToken: request.token, choice, actor }); },
    effects() { return Number(store.db.prepare("SELECT count(*) AS n FROM effects").get()!.n); },
    async reopen() { await runtime.close(); store.close(); store = new HumanReviewStore(directory, reviewers); runtime = openRuntime(); },
    async close() { await runtime.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("approval presents the exact operation and blocks direct tool execution until a matching decision", async () => {
  const s = await setup();
  try {
    const waiting = await runApproval(s.runtime, s.input);
    assert.equal(waiting.job.stage, "awaiting-review"); assert.equal(s.effects(), 0);
    assert.equal((await readJson(join(s.directory, "task.deployment.json"))).active, false);
    assert.deepEqual((await readJson(join(s.directory, `inbox/${waiting.request!.id}.json`))).snapshot, waiting.request!.snapshot);
    assert.equal(waiting.request!.snapshot.operation.beforeDigest, waiting.job.targetBeforeDigest);
    await assert.rejects(s.runtime.run(executionGraph, { id: "task", artifact: waiting.artifact! }), /Human approval required/);
    assert.ok(!s.store.tools.some(tool => /decide|approve|edit|claim/.test(tool.name)));
    await s.reopen(); s.decide("example-operator");
    const completed = await runApproval(s.runtime, s.input);
    assert.equal(completed.job.stage, "completed"); assert.equal(s.calls(), 1); assert.equal(s.effects(), 1);
    const deployed = await readJson(join(s.directory, "task.deployment.json"));
    assert.equal(deployed.active, true); assert.equal(deployed.reviewToken, waiting.request!.token);
  } finally { await s.close(); }
});

test("rejection preserves the reviewed result without performing activation or publication", async () => {
  for (const mode of ["approval", "publish"] as const) {
    const s = await setup(mode), run = mode === "approval" ? runApproval : runReviewPublish;
    try {
      await run(s.runtime, s.input); s.decide(mode === "approval" ? "example-operator" : "example-publisher", "reject");
      assert.equal((await run(s.runtime, s.input)).job.stage, "rejected"); assert.equal(s.effects(), 0); assert.equal(s.calls(), 1);
      await assert.rejects(readFile(join(s.directory, "published/task.json")), { code: "ENOENT" });
    } finally { await s.close(); }
  }
});

test("intermediate confirmation gates the second model stage and real calendar export", async () => {
  const s = await setup("intermediate");
  try {
    await runIntermediate(s.runtime, s.input); assert.equal(s.calls(), 1);
    await assert.rejects(readFile(join(s.directory, "private/task.ics")), { code: "ENOENT" });
    s.decide("example-editor"); const completed = await runIntermediate(s.runtime, s.input);
    assert.equal(completed.job.stage, "completed"); assert.equal(s.calls(), 2);
    assert.ok((await readFile(join(s.directory, "private/task.ics"), "utf8")).includes("DTSTART;VALUE=DATE:20261210"));
    assert.deepEqual((await readJson(join(s.directory, "private/task.json"))).content, completed.artifact!.draft);
  } finally { await s.close(); }
});

test("editing versions the artifact, replaces review and feeds the edited date/title to continuation", async () => {
  const s = await setup("edit");
  try {
    const first = await runEditContinue(s.runtime, s.input), gate = first.request!;
    const replacement = { ...first.artifact!.draft, date: "2027-01-15", title: "Human corrected title", body: "Human corrected body" };
    s.store.edit({ requestId: gate.id, expectedToken: gate.token, replacement, actor: "example-editor", note: "Correct date and audience wording" });
    assert.throws(() => s.store.decide({ requestId: gate.id, expectedToken: gate.token, choice: "approve", actor: "example-editor" }), /Stale/);
    const revised = await runEditContinue(s.runtime, s.input); assert.equal(revised.artifact!.version, 2); assert.notEqual(revised.request!.token, gate.token);
    assert.equal(s.calls(), 1); assert.equal(s.effects(), 0); assert.equal(s.store.version("task", 1).draft.date, "2026-12-10");
    await s.reopen(); s.decide("example-editor"); await runEditContinue(s.runtime, s.input);
    const saved = await readJson(join(s.directory, "private/task.json"));
    assert.deepEqual(saved.content, replacement); assert.equal(saved.calendar.date, replacement.date); assert.equal(saved.calendar.title, replacement.title);
    assert.ok((await readFile(join(s.directory, "private/task.ics"), "utf8")).includes("20270115"));
  } finally { await s.close(); }
});

test("reviewed publication is byte-faithful and repeated execution never regenerates it", async () => {
  const s = await setup("publish");
  try {
    const waiting = await runReviewPublish(s.runtime, s.input); s.decide("example-publisher"); await runReviewPublish(s.runtime, s.input);
    const path = join(s.directory, "published/task.json"), before = await readFile(path, "utf8");
    const saved = JSON.parse(before); assert.deepEqual(saved.content, waiting.artifact!.draft); assert.equal(saved.digest, waiting.artifact!.digest);
    assert.equal(saved.reviewToken, waiting.request!.token);
    await s.reopen(); await runReviewPublish(s.runtime, s.input);
    assert.equal(await readFile(path, "utf8"), before); assert.equal(s.calls(), 1); assert.equal(s.effects(), 1);
  } finally { await s.close(); }
});

test("editing after approval invalidates the old approval before publication", async () => {
  const s = await setup("publish");
  try {
    const original = await runReviewPublish(s.runtime, s.input); s.decide("example-publisher");
    s.store.edit({ requestId: original.request!.id, expectedToken: original.request!.token, replacement: { ...original.artifact!.draft, body: "New reviewed body" }, actor: "example-publisher", note: "Updated language" });
    await assert.rejects(s.runtime.run(executionGraph, { id: "task", artifact: original.artifact! }), /approval required/);
    const current = await runReviewPublish(s.runtime, s.input); assert.equal(current.job.stage, "awaiting-review"); assert.equal(s.effects(), 0);
    s.decide("example-publisher"); await runReviewPublish(s.runtime, s.input);
    assert.equal((await readJson(join(s.directory, "published/task.json"))).content.body, "New reviewed body");
  } finally { await s.close(); }
});

test("wrong roles, stale tokens, duplicate decisions and hidden proposals cannot authorize work", async () => {
  const s = await setup("approval");
  try {
    s.rejectDelivery(true); await assert.rejects(runApproval(s.runtime, s.input), /presentation/);
    const request = s.store.request(s.store.job("task").gateId!);
    assert.throws(() => s.decide("example-operator"), /undelivered/);
    s.rejectDelivery(false); await runApproval(s.runtime, s.input);
    assert.throws(() => s.decide("example-publisher"), /authorized/);
    assert.throws(() => s.store.decide({ requestId: request.id, expectedToken: "wrong", choice: "approve", actor: "example-operator" }), /Stale/);
    s.decide("example-operator"); assert.throws(() => s.decide("example-operator"), /already decided/);
    await runApproval(s.runtime, s.input); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});

test("a human edit racing the downstream model prevents stale-version effects", async () => {
  let onCalendar = () => {};
  const s = await setup("edit", async input => { if (JSON.parse(String(input.messages[1]!.content)).artifact) onCalendar(); return answer(input); });
  try {
    const original = await runEditContinue(s.runtime, s.input); s.decide("example-editor");
    onCalendar = () => s.store.edit({ requestId: original.request!.id, expectedToken: original.request!.token,
      replacement: { ...original.artifact!.draft, title: "Changed during generation" }, actor: "example-editor", note: "Concurrent edit" });
    await assert.rejects(runEditContinue(s.runtime, s.input), /approval required/); assert.equal(s.effects(), 0);
    assert.equal(s.store.job("task").currentVersion, 2);
    onCalendar = () => {}; await runEditContinue(s.runtime, s.input); s.decide("example-editor"); await runEditContinue(s.runtime, s.input);
    assert.equal((await readJson(join(s.directory, "private/task.json"))).calendar.title, "Changed during generation");
  } finally { await s.close(); }
});

test("handoff retains sources, candidate, Context and progress, and only a triager can claim it", async () => {
  const s = await setup("escalation");
  try {
    const result = await runEscalation(s.runtime, s.input), request = result.request!;
    assert.equal(result.job.stage, "escalated"); assert.equal(result.job.reason, "CONFLICTING_DATES"); assert.equal(s.effects(), 0);
    assert.deepEqual(request.snapshot.handoff!.sources, s.source); assert.ok(request.snapshot.handoff!.context!.items.length);
    assert.ok(request.snapshot.handoff!.events.length); assert.deepEqual(request.snapshot.proposal, result.artifact!.draft);
    assert.throws(() => s.decide("example-triager"), /handoff/);
    assert.throws(() => s.store.claim({ requestId: request.id, expectedToken: request.token, actor: "example-editor", note: "Pick up" }), /authorized/);
    await s.reopen(); s.store.claim({ requestId: request.id, expectedToken: request.token, actor: "example-triager", note: "Verify the conflicting release dates" });
    const assigned = await runEscalation(s.runtime, s.input); assert.equal(assigned.job.assignee, "example-triager"); assert.equal(assigned.job.stage, "escalated"); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});

test("an undelivered escalation can be presented again without repeating inference", async () => {
  const s = await setup("escalation");
  try {
    s.rejectDelivery(true); await assert.rejects(runEscalation(s.runtime, s.input), /presentation/);
    s.rejectDelivery(false); const result = await runEscalation(s.runtime, s.input);
    assert.equal(result.request!.delivered, true); assert.equal(s.calls(), 1);
  } finally { await s.close(); }
});

test("failed or unusable model output is escalated with source evidence and no invented draft", async () => {
  for (const kind of ["failed", "invalid", "truncated"] as const) {
    const s = await setup("escalation", async input => {
      if (kind === "failed") throw new Error("Provider unavailable");
      return kind === "truncated" ? { ...answer(input), finishReason: "length" } : response({ nonsense: true });
    });
    try {
      const result = await runEscalation(s.runtime, s.input);
      assert.equal(result.job.reason, kind === "failed" ? "MODEL_FAILED" : "MODEL_INVALID"); assert.equal(result.artifact, null); assert.ok(result.request!.snapshot.handoff!.context!.items.length);
      assert.deepEqual(result.request!.snapshot.handoff!.sources, s.source); assert.equal(s.effects(), 0);
    } finally { await s.close(); }
  }
});

test("conflicting evidence escalates even when invoked through the activation workflow", async () => {
  const s = await setup("approval");
  try {
    // Create a separate actual task whose immutable source includes conflicting dates.
    const source = { ...s.source, sources: [{ id: "one", date: "2026-12-10" }, { id: "two", date: "2026-12-11" }] };
    await writeFile(join(s.directory, "conflict.source.json"), JSON.stringify(source));
    await writeFile(join(s.directory, "conflict.deployment.json"), JSON.stringify({ releaseId: source.releaseId, active: false }));
    await s.store.create("conflict", "approval");
    const result = await runApproval(s.runtime, { ...s.input, id: "conflict" });
    assert.equal(result.job.stage, "escalated"); assert.equal(result.request!.snapshot.purpose, "handoff"); assert.equal(s.effects(), 0);
  } finally { await s.close(); }
});

test("an effect claim prevents further edits, and an interrupted publication resumes its approved snapshot", async () => {
  const s = await setup("publish");
  try {
    const waiting = await runReviewPublish(s.runtime, s.input); s.decide("example-publisher");
    await mkdir(join(s.directory, "published")); await writeFile(join(s.directory, "published/task.json"), "conflicting artifact");
    await assert.rejects(runReviewPublish(s.runtime, s.input)); assert.equal(s.store.job("task").stage, "executing");
    assert.throws(() => s.store.edit({ requestId: waiting.request!.id, expectedToken: waiting.request!.token, replacement: waiting.artifact!.draft, actor: "example-publisher", note: "Attempted edit after execution started" }), /cannot be edited/);
    await rm(join(s.directory, "published/task.json")); await s.reopen(); await runReviewPublish(s.runtime, s.input);
    assert.equal(s.store.job("task").stage, "completed"); assert.equal(s.effects(), 1); assert.equal(s.calls(), 1);
    assert.equal((await readJson(join(s.directory, "published/task.json"))).digest, digest(waiting.artifact!.draft));
  } finally { await s.close(); }
});

test("deployment drift and caller cancellation never produce an unauthorized activation", async () => {
  const s = await setup();
  try {
    await assert.rejects(runApproval(s.runtime, s.input, { signal: AbortSignal.abort(new Error("caller cancelled")) }), /caller cancelled/); assert.equal(s.calls(), 0);
    await runApproval(s.runtime, s.input); s.decide("example-operator");
    await writeFile(join(s.directory, "task.deployment.json"), JSON.stringify({ releaseId: "another-release", active: false }));
    await assert.rejects(runApproval(s.runtime, s.input), /changed since human review/);
    assert.equal((await readJson(join(s.directory, "task.deployment.json"))).releaseId, "another-release"); assert.notEqual(s.store.job("task").stage, "completed");
  } finally { await s.close(); }
});
