import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker, createInMemoryContextStore } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { openSqliteMemory } from "../examples/_shared/tools/storage/sqlite-memory.ts";
import { UnderstandingStore, fields, type Analysis, type Mode, type Turn } from "../examples/_shared/tools/understanding-store.ts";
import { createFixture, request } from "../examples/capabilities/understanding/fixtures.ts";
import { runUnderstanding, prepareContext } from "../examples/capabilities/understanding/shared.ts";
function answer(input: SampleInput): Analysis {
  const turns = JSON.parse(String(input.messages[1]!.content)) as Turn[], users = turns.filter(t => t.role === "user"), first = users[0]!, last = users.at(-1)!;
  const incomplete = first.text.endsWith("发布报告。") && users.length === 1;
  const value: Analysis = { intent: /取消/.test(last.text) ? "cancel" : /进度/.test(last.text) ? "status" : /不确定/.test(last.text) ? "unknown" : "create_report", topic: /ORION-[a-f0-9]+/.exec(first.text)![0], audience: "engineering", deadline: incomplete ? null : "2027-12-15T09:00:00.000Z", format: incomplete ? null : last.text.includes("JSON") ? "json" : "markdown", budgetCents: incomplete ? null : 2500, permission: incomplete ? null : last.text.includes("立即发布") ? "publish" : "draft_only", scope: incomplete ? null : last.text.includes("只保留变更") ? ["changes"] : ["changes", "metrics"], evidence: {} };
  for (const field of ["intent", ...fields] as const) { if (value[field] !== null && !(field === "intent" && value.intent === "unknown")) { const t = field === "intent" || (field === "format" && users.length > 1) || (field === "scope" && users.length > 1) || (incomplete === false && first.text.endsWith("发布报告。") && !["topic", "audience"].includes(field)) ? last : first; value.evidence[field] = { turnId: t.id, quote: t.text }; } }
  return value;
}
async function setup(mode: Mode = "goal", invoke?: (input: SampleInput) => Promise<SampleOutput>) {
  const directory = await mkdtemp(join(tmpdir(), "ditto-understanding-test-")), fixture = await createFixture(directory, mode);
  let store = new UnderstandingStore(directory), calls = 0, failDelivery = false;
  let memory = openSqliteMemory(join(directory, "memory.sqlite"));
  const cache = createInMemoryContextStore();
  const open = () => createDitto({ sandbox: { tools: store.tools.map(t => t.name) }, workers: [createContextWorker({ services: { stateStore: cache } }), createMemoryWorker({ store: memory.store }), createInferWorker({ providers: { unit: { async invoke(input) { calls++; return invoke ? invoke(input) : { message: { role: "assistant", content: JSON.stringify(answer(input)) }, finishReason: "stop" }; } } } }), createInteractionWorker({ tools: store.tools, output: { deliver: (input, context) => { if (failDelivery) throw new Error("Inbox unavailable"); return store.output.deliver(input, context); } } })] });
  let runtime = open(); await store.create("session", mode, fixture.message);
  return { ...fixture, directory, get store() { return store; }, get runtime() { return runtime; }, calls: () => calls, failDelivery(value: boolean) { failDelivery = value; },
    run: (signal?: AbortSignal) => runUnderstanding(runtime, { id: "session", model: { provider: "unit", model: "unit" } }, mode, signal ? { signal } : {}),
    reply(text: string, messageId = "user-2") { const s = store.session("session"); return store.receive({ id: s.id, messageId, text, expectedRevision: s.revision, ...(s.view ? { replyToken: s.view.token } : {}) }); },
    async reopen() { await runtime.close(); await memory.close(); store.close(); store = new UnderstandingStore(directory); memory = openSqliteMemory(join(directory, "memory.sqlite")); runtime = open(); },
    async close() { await runtime.close(); await memory.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}
test("goal and constraints produce a grounded analysis and an actual scoped report through public nodes", async () => {
  const s = await setup(); try { const r = await s.run(); assert.equal(r.stage, "completed"); assert.equal(r.analysis!.topic, s.source.topic); assert.equal(r.analysis!.budgetCents, 2500); assert.deepEqual(r.artifact!.content.sections, { changes: s.source.changes, metrics: s.source.metrics }); assert.ok((await readFile(join(s.directory, r.artifact!.file), "utf8")).includes(s.source.changes[0]!)); assert.ok((await prepareContext(s.runtime, r)).items.length); await s.reopen(); assert.deepEqual(await s.run(), r); assert.equal(s.calls(), 1); } finally { await s.close(); }
});
test("clarification delivers missing fields, requires a reply token and resumes from saved Context", async () => {
  const s = await setup("clarification"); try { const first = await s.run(); assert.equal(first.stage, "needs_clarification"); assert.equal(first.artifact, null); assert.deepEqual(first.view!.missing, ["deadline", "format", "budgetCents", "permission", "scope"]); assert.throws(() => s.store.receive({ id: "session", messageId: "user-2", text: "回答", expectedRevision: 1 }), /token/); await s.reopen(); s.reply("截止时间 2027-12-15T09:00:00.000Z，Markdown，人民币 25 元，仅草稿，变更和指标。"); const done = await s.run(); assert.equal(done.stage, "completed"); assert.equal(done.analysis!.topic, s.source.topic); assert.ok((await prepareContext(s.runtime, done)).items.some(x => x.id === "assistant-1")); assert.equal(s.calls(), 2); } finally { await s.close(); }
});
test("multi-turn correction retains prior facts and exports a new exact format and scope", async () => {
  const s = await setup("conversation"); try { const first = await s.run(); await s.reopen(); s.reply("改成 JSON 格式，只保留变更，其余约束不变。"); const next = await s.run(); assert.equal(next.stage, "completed"); assert.equal(next.artifact!.format, "json"); assert.deepEqual(next.artifact!.content.sections, { changes: s.source.changes }); assert.equal(next.analysis!.deadline, first.analysis!.deadline); assert.notEqual(next.artifact!.file, first.artifact!.file); assert.deepEqual(JSON.parse(await readFile(join(s.directory, next.artifact!.file), "utf8")), next.artifact!.content); } finally { await s.close(); }
});
test("choices are delivered without effects and only a current valid selection continues", async () => {
  const s = await setup("choices"); try { const pending = await s.run(); assert.equal(pending.stage, "awaiting_choice"); assert.equal(pending.view!.choices.length, 2); assert.equal(pending.artifact, null); assert.throws(() => s.store.choose({ id: "session", expectedRevision: 1, token: "stale", choiceId: "brief" })); assert.throws(() => s.store.choose({ id: "session", expectedRevision: 1, token: pending.view!.token, choiceId: "alien" })); await s.reopen(); s.store.choose({ id: "session", expectedRevision: 1, token: pending.view!.token, choiceId: "detailed" }); const done = await s.run(); assert.equal(done.stage, "completed"); assert.equal(done.artifact!.content.style, "detailed"); assert.equal(done.revision, 2); assert.equal(s.calls(), 1); assert.ok((await readFile(join(s.directory, done.artifact!.file), "utf8")).includes("Reading guide")); } finally { await s.close(); }
});
test("status and cancellation intents preserve prior artifacts without new business effects", async () => {
  const s = await setup("intent"); try { await s.run(); s.reply("查询进度。"); const status = await s.run(); assert.equal(status.stage, "answered"); assert.equal(status.artifact!.revision, 1); s.reply("取消任务。", "user-3"); assert.equal((await s.run()).stage, "cancelled"); assert.equal(Number(s.store.db.prepare("SELECT count(*) AS n FROM artifacts").get()!.n), 1); } finally { await s.close(); }
});
test("unknown intent asks instead of guessing and requested publication cannot grant authority", async () => {
  const s = await setup("intent"); try { s.reply("我不确定要做什么。"); assert.equal((await s.run()).stage, "needs_clarification"); s.reply(request(s.source.topic) + "请立即发布。", "user-3"); const denied = await s.run(); assert.equal(denied.stage, "blocked"); assert.equal(denied.reason, "POLICY_DENIED"); assert.equal(denied.artifact, null); } finally { await s.close(); }
});
test("invalid provenance, malformed or truncated model results fail without a task artifact", async () => {
  for (const failure of ["evidence", "malformed", "truncated", "provider"] as const) {
    const s = await setup("goal", async input => { if (failure === "provider") throw new Error("unavailable"); const a = answer(input); if (failure === "evidence") a.evidence.topic = { turnId: "assistant-1", quote: "fabricated" }; return { message: { role: "assistant", content: failure === "malformed" ? "{}" : JSON.stringify(a) }, finishReason: failure === "truncated" ? "length" : "stop" }; });
    try { const result = await s.run(); assert.equal(result.stage, "failed"); assert.equal(result.artifact, null); } finally { await s.close(); }
  }
});
test("delivery failure preserves the question, blocks replies and retries without another inference", async () => {
  const s = await setup("clarification"); try { s.failDelivery(true); await assert.rejects(s.run()); assert.throws(() => s.reply("回答"), /token/); await s.reopen(); s.failDelivery(false); assert.equal((await s.run()).view!.delivered, true); assert.equal(s.calls(), 1); } finally { await s.close(); }
});
test("new messages during inference invalidate the old output rather than overwriting the conversation", async () => {
  let changed = false;
  const s = await setup("conversation", async input => { if (!changed) { changed = true; s.reply("改成 JSON 格式，只保留变更，其余约束不变。"); } return { message: { role: "assistant", content: JSON.stringify(answer(input)) }, finishReason: "stop" }; });
  try { const first = await s.run(); assert.equal(first.stage, "received"); assert.equal(first.artifact, null); const second = await s.run(); assert.equal(second.artifact!.format, "json"); assert.equal(second.artifact!.revision, 2); } finally { await s.close(); }
});
test("message deduplication rejects conflicting payloads and stale revisions", async () => {
  const s = await setup("conversation"); try { await s.run(); const r = s.reply("改成 JSON 格式。"); assert.deepEqual(s.store.receive({ id: "session", messageId: "user-2", text: "改成 JSON 格式。", expectedRevision: 1 }), r); assert.throws(() => s.store.receive({ id: "session", messageId: "user-2", text: "different", expectedRevision: 1 }), /conflict/); assert.throws(() => s.store.receive({ id: "session", messageId: "user-3", text: "another", expectedRevision: 1 }), /changed/); } finally { await s.close(); }
});
test("changed source and insufficient budget prevent execution after inference", async () => {
  for (const kind of ["source", "budget", "deadline"] as const) {
    const s = await setup("constraints", async input => { const a = answer(input); if (kind === "source") await writeFile(join(s.directory, "source.json"), JSON.stringify({ ...s.source, changes: ["Changed"] })); if (kind === "budget") a.budgetCents = 100; if (kind === "deadline") a.deadline = "2020-01-01T00:00:00.000Z"; return { message: { role: "assistant", content: JSON.stringify(a) }, finishReason: "stop" }; });
    try { const result = await s.run(); assert.equal(result.stage, "blocked"); assert.equal(result.artifact, null); } finally { await s.close(); }
  }
});
test("pre-cancellation never infers or creates a report and records a user-visible cancellation", async () => {
  const s = await setup(); try { const result = await s.run(AbortSignal.abort()); assert.equal(result.stage, "cancelled"); assert.equal(result.view!.delivered, true); assert.equal(s.calls(), 0); } finally { await s.close(); }
});

test("understanding examples and their adapter use only exported Core module entries", async () => {
  const { auditSource, sourceFiles } = await import("../scripts/lib/control-flow-boundary.ts");
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  const entries = Object.keys(manifest.exports).map(key => key === "." ? manifest.name : manifest.name + key.slice(1));
  for (const file of [...await sourceFiles(join(process.cwd(), "examples/capabilities/understanding")), join(process.cwd(), "examples/_shared/tools/understanding-store.ts"), ...await sourceFiles(join(process.cwd(), "examples/_shared/tools/storage"))]) auditSource(await readFile(file, "utf8"), file, entries);
});


test("database MEMORY is durable, idempotent by key, and supports public CRUD and search nodes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ditto-memory-test-"));
  let memory = openSqliteMemory(join(directory, "memory.sqlite"));
  let runtime = createDitto({ workers: [createMemoryWorker({ store: memory.store })] });
  try {
    const draft = { key: "tenant-one:revision-one", content: { text: "Release report", values: [] } };
    const written = await runtime.invoke("MEMORY.WRITE", { memories: [draft] });
    assert.equal(written.status, "success"); const item = written.output![0]!;
    await runtime.close(); await memory.close();
    memory = openSqliteMemory(join(directory, "memory.sqlite"));
    runtime = createDitto({ workers: [createMemoryWorker({ store: memory.store })] });
    const replay = await runtime.invoke("MEMORY.WRITE", { memories: [draft] });
    assert.deepEqual(replay.output, [item]);
    assert.equal((await runtime.invoke("MEMORY.WRITE", { memories: [{ ...draft, content: "conflicting" }] })).status, "failed");
    assert.deepEqual((await runtime.invoke("MEMORY.GET", { keys: [draft.key] })).output, [item]);
    assert.deepEqual((await runtime.invoke("MEMORY.GET", { keys: ["another-tenant"] })).output, []);
    assert.equal((await runtime.invoke("MEMORY.QUERY", { filter: { key: draft.key } })).output!.items.length, 1);
    assert.equal((await runtime.invoke("MEMORY.SEARCH", { query: "Release", filter: { key: draft.key } })).output![0]!.memory.id, item.id);
    assert.deepEqual((await runtime.invoke("MEMORY.UPDATE", { memories: [{ id: item.id, metadata: { checked: true } }] })).output![0]!.metadata, { checked: true });
    assert.deepEqual((await runtime.invoke("MEMORY.DELETE", { ids: [item.id] })).output!.deleted, [item.id]);
    assert.deepEqual((await runtime.invoke("MEMORY.DELETE", { ids: [item.id] })).output!.deleted, []);
  } finally { await runtime.close(); await memory.close(); await rm(directory, { recursive: true, force: true }); }
});
