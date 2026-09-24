import { limitCapabilityCases } from "./lib/capability-cases.ts";
/** Real conversation tasks: HTTP inference, durable turns, actual questions/choices and report files. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { DatabaseSync } from "node:sqlite";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { openUnderstandingStorage } from "../examples/capabilities/understanding/storage.ts";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { UnderstandingStore, type Mode, type Stage } from "../examples/_shared/tools/understanding-store.ts";
import { createFixture } from "../examples/capabilities/understanding/fixtures.ts";
import { runGoal } from "../examples/capabilities/understanding/goal.ts";
import { runConstraints } from "../examples/capabilities/understanding/extract-parameters.ts";
import { runClarification } from "../examples/capabilities/understanding/clarification.ts";
import { runConversation } from "../examples/capabilities/understanding/conversation.ts";
import { runChoices } from "../examples/capabilities/understanding/choices.ts";
import { runIntent } from "../examples/capabilities/understanding/intent.ts";
import { report, prepareContext, contextScope, memoryKey } from "../examples/capabilities/understanding/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-understanding-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-understanding-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]); const model = config.providers[provider].model ?? config.model?.model; assert.ok(model);
const input = { id: "session", model: { provider, model } };
const runners = { goal: runGoal, constraints: runConstraints, clarification: runClarification, conversation: runConversation, choices: runChoices, intent: runIntent };
const scenarios: { name: string; mode: Mode; stage: Stage; calls: number }[] = [
  { name: "goal-to-local-report", mode: "goal", stage: "completed", calls: 1 },
  { name: "constraints-time-money-permission-scope", mode: "constraints", stage: "completed", calls: 1 },
  { name: "json-changes-only", mode: "constraints", stage: "completed", calls: 1 },
  { name: "clarify-and-resume", mode: "clarification", stage: "completed", calls: 2 },
  { name: "multi-turn-edit-and-status", mode: "conversation", stage: "answered", calls: 3 },
  { name: "choose-detailed-plan", mode: "choices", stage: "completed", calls: 1 },
  { name: "intent-status-without-report", mode: "intent", stage: "answered", calls: 1 },
  { name: "intent-cancel-without-effect", mode: "intent", stage: "cancelled", calls: 1 },
  { name: "ambiguous-intent-asks-user", mode: "intent", stage: "needs_clarification", calls: 1 },
  { name: "requested-publish-is-not-authorization", mode: "constraints", stage: "blocked", calls: 1 },
  { name: "budget-blocks-report", mode: "constraints", stage: "blocked", calls: 1 },
  { name: "expired-deadline-blocks-report", mode: "constraints", stage: "blocked", calls: 1 },
  { name: "new-turn-during-inference", mode: "conversation", stage: "completed", calls: 2 },
  { name: "actual-inbox-failure-retry", mode: "clarification", stage: "needs_clarification", calls: 1 },
  { name: "clarification-process-crash-resume", mode: "clarification", stage: "completed", calls: 2 },
  { name: "choice-process-crash-resume", mode: "choices", stage: "completed", calls: 1 },
  { name: "source-drift-blocks-report", mode: "goal", stage: "blocked", calls: 1 },
  { name: "cancel-before-inference", mode: "goal", stage: "cancelled", calls: 0 },
  { name: "choices-respect-budget", mode: "choices", stage: "completed", calls: 1 },
  { name: "missing-timezone-needs-clarification", mode: "clarification", stage: "needs_clarification", calls: 1 },
  { name: "redis-expiry-memory-restore", mode: "conversation", stage: "completed", calls: 2 },
  { name: "redis-unavailable-before-inference", mode: "goal", stage: "completed", calls: 1 },
  { name: "memory-unavailable-before-inference", mode: "goal", stage: "completed", calls: 1 },
  { name: "memory-write-failure-after-report", mode: "goal", stage: "completed", calls: 1 },
  { name: "memory-acknowledgement-crash", mode: "goal", stage: "completed", calls: 1 },
];
limitCapabilityCases(scenarios);
await mkdir(resolve(values["output-dir"]!), { recursive: true }); const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const caseDirectory = join(directory, scenario.name); await mkdir(caseDirectory); const fixture = await createFixture(caseDirectory, scenario.mode);
  let message = fixture.message;
  if (scenario.name === "constraints-time-money-permission-scope") message = message.replace("2027-12-15T09:00:00.000Z", "2027年12月15日北京时间17:00:00");
  if (scenario.name === "json-changes-only") message = message.replace("Markdown", "JSON").replace("变更记录和指标", "变更记录");
  if (scenario.name === "intent-status-without-report") message = "请告诉我当前报告的进度，不要重新生成报告。";
  if (scenario.name === "intent-cancel-without-effect") message = "取消这次报告任务，不要继续生成任何内容。";
  if (scenario.name === "ambiguous-intent-asks-user") message = "请帮我处理一下，我还没有决定要生成什么或查询什么。";
  if (scenario.name === "requested-publish-is-not-authorization") message = message.replace("仅生成本地草稿，不要发布", "生成后立即公开发布");
  if (scenario.name === "budget-blocks-report") message = message.replace("25 元", "1 元");
  if (scenario.name === "expired-deadline-blocks-report") message = message.replace("2027-12-15", "2020-01-01");
  if (scenario.name === "choices-respect-budget") message = message.replace("25 元", "8 元");
  if (scenario.name === "missing-timezone-needs-clarification") message += "截止时间是 12 月 15 日下午五点，格式 JSON，预算 25 元，仅生成草稿，范围仅变更。";
  await writeFile(join(caseDirectory, "request.txt"), message);
  let store = new UnderstandingStore(caseDirectory); await store.create("session", scenario.mode, await readFile(join(caseDirectory, "request.txt"), "utf8"));
  const spans: Record<string, unknown>[] = [], children: Record<string, unknown>[] = [];
  let afterSample: (() => Promise<void>) | undefined;
  function observed(definition: WorkerDefinition): WorkerDefinition { return { ...definition, instantiate() { const worker = definition.instantiate(); return {
    async execute(node, args, context) { const span: Record<string, unknown> = { node, ...context.execution, start: Date.now() }; spans.push(span); try { const value = await worker.execute(node, args, context); if (node === "INFER.REASONING.SAMPLE") { span.result = value; await afterSample?.(); } return value; } finally { span.end = Date.now(); } }, async dispose() { await worker.dispose?.(); },
  }; } }; }
  let storage = await openUnderstandingStorage(caseDirectory, config);
  const open = () => createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(t => t.name) }, workers: [...storage.workers.map(observed), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools, output: store.output }))] });
  let runtime = open(); const run = () => runners[scenario.mode](runtime, input);
  const reopen = async () => { await runtime.close(); await storage.close(); store.close(); store = new UnderstandingStore(caseDirectory); storage = await openUnderstandingStorage(caseDirectory, config); runtime = open(); };
  const reply = (text: string, messageId = "user-2") => { const s = store.session("session"); return store.receive({ id: s.id, text, messageId, expectedRevision: s.revision, ...(s.view ? { replyToken: s.view.token } : {}) }); };
  const choose = (choiceId: string) => { const s = store.session("session"); return store.choose({ id: s.id, expectedRevision: s.revision, token: s.view!.token, choiceId }); };
  const supplement = "截止时间为 2027-12-15T09:00:00.000Z，使用 Markdown 格式，预算人民币 25 元，仅生成本地草稿，不要发布。范围包含变更记录和指标。";
  const correction = "改成 JSON 格式，只保留变更记录，其他目标和限制保持不变。";
  async function child(phase: string) {
    await new Promise<void>((done, reject) => { const proc = spawn(process.execPath, ["scripts/fixtures/understanding-child.ts", "--directory", caseDirectory, "--phase", phase, "--provider", provider!], { env: process.env, stdio: ["ignore", "ignore", "pipe"] }); let stderr = ""; proc.stderr.on("data", x => { stderr += String(x); }); proc.once("error", reject); proc.once("exit", (code, signal) => phase.endsWith("crash") ? signal === "SIGKILL" ? done() : reject(new Error(stderr)) : code === 0 ? done() : reject(new Error(stderr))); });
    const saved = await readJson(join(caseDirectory, `child-${phase}.json`)); children.push(saved); return saved.result;
  }
  const record: Record<string, unknown> = { name: scenario.name, status: "failed", directory: caseDirectory };
  try {
    switch (scenario.name) {
      case "clarify-and-resume": { const pending = await run(); assert.equal(pending.stage, "needs_clarification"); assert.equal(pending.artifact, null); assert.ok(pending.view!.missing.includes("deadline")); await reopen(); reply(supplement); await run(); break; }
      case "multi-turn-edit-and-status": await run(); await reopen(); reply(correction); assert.equal((await run()).artifact!.format, "json"); reply("现在报告的进度是什么？不要生成新报告。", "user-3"); await run(); break;
      case "choose-detailed-plan": { const pending = await run(); assert.equal(pending.stage, "awaiting_choice"); assert.equal(pending.view!.choices.length, 2); assert.equal(pending.artifact, null); assert.throws(() => store.choose({ id: "session", expectedRevision: 1, token: "stale", choiceId: "brief" })); await reopen(); choose("detailed"); await run(); break; }
      case "new-turn-during-inference": afterSample = async () => { afterSample = undefined; reply(correction); }; assert.equal((await run()).stage, "received"); await run(); break;
      case "actual-inbox-failure-retry": await writeFile(join(caseDirectory, "inbox"), "not a directory"); await assert.rejects(run()); assert.throws(() => reply(supplement)); await rm(join(caseDirectory, "inbox")); await reopen(); await run(); break;
      case "clarification-process-crash-resume": assert.equal((await child("waiting-crash")).stage, "needs_clarification"); reply(supplement); assert.equal((await child("continue")).stage, "completed"); break;
      case "choice-process-crash-resume": assert.equal((await child("waiting-crash")).stage, "awaiting_choice"); choose("detailed"); assert.equal((await child("continue")).stage, "completed"); break;
      case "source-drift-blocks-report": afterSample = () => writeFile(join(caseDirectory, "source.json"), JSON.stringify({ ...fixture.source, changes: ["Changed source"] })); await run(); break;
      case "cancel-before-inference": await runGoal(runtime, input, { signal: AbortSignal.abort() }); break;
      case "choices-respect-budget": { const pending = await run(); assert.deepEqual(pending.view!.choices.map(x => x.id), ["brief"]); assert.throws(() => choose("detailed")); choose("brief"); await run(); break; }
      case "redis-expiry-memory-restore": {
        const first = await run();
        const key = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(contextScope(first));
        await storage.redis.pExpire(key, 1); await delay(20); assert.equal(await storage.redis.get(key), null);
        await reopen();
        assert.deepEqual((await prepareContext(runtime, store.session("session"))).items.map(item => item.content), first.turns);
        reply(correction); await run(); break;
      }
      case "redis-unavailable-before-inference":
        await storage.redis.quit(); await assert.rejects(run()); assert.equal(store.session("session").stage, "received");
        assert.equal(spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length, 0); await reopen(); await run(); break;
      case "memory-unavailable-before-inference": {
        const database = new DatabaseSync(join(caseDirectory, "memory.sqlite"));
        try {
          database.exec("ALTER TABLE memories RENAME TO unavailable_memories");
          await assert.rejects(run(), /MEMORY failed/); assert.equal(store.session("session").stage, "received");
          assert.equal(spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length, 0);
          database.exec("ALTER TABLE unavailable_memories RENAME TO memories");
        } finally { database.close(); }
        await reopen(); await run(); break;
      }
      case "memory-write-failure-after-report": {
        const database = new DatabaseSync(join(caseDirectory, "memory.sqlite"));
        try {
          database.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'database write unavailable'); END");
          await assert.rejects(run(), /MEMORY failed/); assert.equal(store.session("session").stage, "completed");
          assert.equal(store.session("session").memoryRevision, 0);
          database.exec("DROP TRIGGER fail_memory");
        } finally { database.close(); }
        await reopen(); await run(); break;
      }
      case "memory-acknowledgement-crash":
        assert.equal((await child("archive-crash")).memoryRevision, 0);
        assert.equal((await child("continue")).memoryRevision, 1); break;
      default: await run();
    }
    const saved = await report(runtime, "session"); assert.equal(saved.stage, scenario.stage); assert.equal(saved.view!.delivered, true);
    const effectCount = Number(store.db.prepare("SELECT count(*) AS n FROM artifacts").get()!.n);
    assert.equal(effectCount, ["multi-turn-edit-and-status", "redis-expiry-memory-restore"].includes(scenario.name) ? 2 : saved.stage === "completed" ? 1 : 0);
    if (saved.artifact) {
      assert.equal(saved.artifact.content.topic, fixture.source.topic); assert.equal(saved.artifact.content.audience, "engineering"); assert.equal(saved.artifact.content.deadline, "2027-12-15T09:00:00.000Z");
      const onlyChanges = ["json-changes-only", "new-turn-during-inference", "multi-turn-edit-and-status", "redis-expiry-memory-restore"].includes(scenario.name);
      assert.deepEqual(saved.artifact.content.sections, onlyChanges ? { changes: fixture.source.changes } : { changes: fixture.source.changes, metrics: fixture.source.metrics });
      const artifact = await readFile(join(caseDirectory, saved.artifact.file), "utf8"); assert.ok(artifact.includes(fixture.source.changes[0]!)); if (saved.artifact.format === "json") assert.deepEqual(JSON.parse(artifact), saved.artifact.content);
    }
    if (saved.analysis?.intent === "create_report" && !["budget-blocks-report", "choices-respect-budget", "missing-timezone-needs-clarification", "actual-inbox-failure-retry"].includes(scenario.name)) assert.equal(saved.analysis.budgetCents, 2500);
    if (scenario.name === "requested-publish-is-not-authorization") assert.equal(saved.reason, "POLICY_DENIED");
    if (scenario.name === "budget-blocks-report") assert.equal(saved.reason, "BUDGET_EXCEEDED");
    if (scenario.name === "expired-deadline-blocks-report") assert.equal(saved.reason, "DEADLINE_EXPIRED");
    if (scenario.name === "missing-timezone-needs-clarification") assert.ok(saved.view!.missing.includes("deadline"));
    if (scenario.name.includes("clarif") && saved.stage === "completed") assert.ok((await prepareContext(runtime, saved)).items.some(x => x.id === "assistant-1"));
    // Inspect the actual Redis value/TTL and independent MEMORY database before reopening clients.
    const redisKey = (config.context.cache?.keyPrefix ?? "ditto:context:") + contextScopeKey(contextScope(saved));
    const cached = JSON.parse((await storage.redis.get(redisKey))!);
    assert.deepEqual(cached.context.items.map((item: { content: unknown }) => item.content), saved.turns);
    assert.ok(await storage.redis.pTTL(redisKey) > 0);
    const database = new DatabaseSync(join(caseDirectory, "memory.sqlite"), { readOnly: true });
    try {
      const rows = database.prepare("SELECT content FROM memories WHERE memory_key=?").all(memoryKey(saved));
      assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(String(rows[0]!.content)).turns, saved.turns);
    } finally { database.close(); }
    const allSpans = [...spans, ...children.flatMap(child => child.spans as Record<string, unknown>[])];
    assert.ok(allSpans.some(span => span.node === "MEMORY.GET"));
    assert.ok(allSpans.some(span => span.node === "MEMORY.WRITE"));
    assert.ok(allSpans.some(span => span.node === "CONTEXT.UPDATE"));
    record.storage = { context: "redis", memory: "sqlite", revision: saved.memoryRevision, redisTTL: await storage.redis.pTTL(redisKey), archiveKey: memoryKey(saved) };
    const calls = spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, child) => n + Number(child.modelCalls), 0); assert.equal(calls, scenario.calls);
    await reopen(); assert.deepEqual(store.session("session"), saved); assert.deepEqual(await run(), saved); assert.deepEqual(await readJson(join(caseDirectory, "results/session.json")), saved);
    record.status = "passed"; record.result = saved;
  } catch (error) { record.error = error instanceof Error ? error.message : "Understanding task failure"; }
  finally { await runtime.close(); await storage.close(); store.close(); Object.assign(record, { spans, children, modelCalls: spans.filter(s => s.node === "INFER.REASONING.SAMPLE").length + children.reduce((n, child) => n + Number(child.modelCalls), 0) }); results.push(record); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model, directory, results }, null, 2)); console.log(JSON.stringify({ name: scenario.name, status: record.status, modelCalls: record.modelCalls, ...(record.error ? { error: record.error } : {}) })); }
}
const failed = results.filter(r => r.status !== "passed");
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2));
if (failed.length) throw new Error(`${failed.length} understanding task experiments failed`);
