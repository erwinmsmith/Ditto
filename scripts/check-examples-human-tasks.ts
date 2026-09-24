/** Real task acceptance: HTTP models, immutable review inboxes, edits, gated files and process restarts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createContextWorker } from "@ditto/core/worker/context";
import { createInferWorker } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { HumanReviewStore, digest, draft, type HumanMode, type HumanStage } from "../examples/_shared/tools/human-review-store.ts";
import { createFixture, reviewers } from "../examples/control-flow/human/fixtures.ts";
import { runApproval } from "../examples/control-flow/human/approval.ts";
import { runIntermediate } from "../examples/control-flow/human/intermediate.ts";
import { runEditContinue } from "../examples/control-flow/human/edit-and-continue.ts";
import { runReviewPublish } from "../examples/control-flow/human/review-publish.ts";
import { runEscalation } from "../examples/control-flow/human/escalation.ts";
import { executionGraph, report } from "../examples/control-flow/human/shared.ts";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".examples-human-tasks-live-results.json" }, "output-dir": { type: "string", default: ".examples-human-tasks" } } });
const config = loadRuntimeConfigFile("ditto.yaml", process.env), provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const modelName = config.providers[provider].model ?? (provider === config.model?.provider ? config.model.model : undefined); assert.ok(modelName);
const input = { id: "task", model: { provider, model: modelName } };
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const runners = { approval: runApproval, intermediate: runIntermediate, edit: runEditContinue, publish: runReviewPublish, escalation: runEscalation };
const scenarios: { name: string; mode: HumanMode; stage: HumanStage; calls: number }[] = [
  { name: "confirm-before-activation", mode: "approval", stage: "completed", calls: 1 },
  { name: "reject-activation", mode: "approval", stage: "rejected", calls: 1 },
  { name: "confirm-intermediate-result", mode: "intermediate", stage: "completed", calls: 2 },
  { name: "edit-confirm-and-continue", mode: "edit", stage: "completed", calls: 2 },
  { name: "review-exact-publication", mode: "publish", stage: "completed", calls: 1 },
  { name: "reject-publication", mode: "publish", stage: "rejected", calls: 1 },
  { name: "editing-invalidates-approval", mode: "publish", stage: "completed", calls: 1 },
  { name: "wrong-role-cannot-approve", mode: "approval", stage: "awaiting-review", calls: 1 },
  { name: "stale-token-cannot-approve", mode: "publish", stage: "awaiting-review", calls: 1 },
  { name: "complete-handoff-and-assignment", mode: "escalation", stage: "escalated", calls: 1 },
  { name: "inbox-failure-and-retry", mode: "approval", stage: "completed", calls: 1 },
  { name: "pending-review-process-crash", mode: "approval", stage: "completed", calls: 1 },
  { name: "edited-version-across-processes", mode: "edit", stage: "completed", calls: 2 },
  { name: "edit-during-downstream-inference", mode: "edit", stage: "completed", calls: 3 },
  { name: "approved-publish-idempotent-reentry", mode: "publish", stage: "completed", calls: 1 },
  { name: "deployment-drift-blocks-execution", mode: "approval", stage: "executing", calls: 1 },
  { name: "caller-cancelled-before-work", mode: "approval", stage: "queued", calls: 0 },
  { name: "source-change-before-generation", mode: "publish", stage: "queued", calls: 0 },
];
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const results: Record<string, unknown>[] = [], startedAt = new Date().toISOString();
for (const scenario of scenarios) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const caseDirectory = join(directory, scenario.name); await mkdir(caseDirectory);
  const source = await createFixture(caseDirectory, scenario.mode);
  let store = new HumanReviewStore(caseDirectory, reviewers); await store.create("task", scenario.mode);
  const spans: Record<string, unknown>[] = [], children: Record<string, unknown>[] = [];
  let onCalendar: (() => void) | null = null;
  function observed(definition: WorkerDefinition): WorkerDefinition {
    return { ...definition, instantiate() { const worker = definition.instantiate(); return {
      async execute(node, args, context) {
        const span: Record<string, unknown> = { node, ...context.execution, start: performance.now() }; spans.push(span);
        if (node === "INFER.REASONING.SAMPLE" && context.execution?.graphId === "human-continue-with-confirmed-result" && onCalendar) { const edit = onCalendar; onCalendar = null; edit(); }
        try {
          const value = await worker.execute(node, args, context);
          if (value && typeof value === "object" && "status" in value) span.status = value.status;
          if (value && typeof value === "object" && "output" in value && value.output && typeof value.output === "object" && "usage" in value.output) span.usage = value.output.usage;
          return value;
        } finally { span.end = performance.now(); }
      }, async dispose() { await worker.dispose?.(); },
    }; } };
  }
  const openRuntime = () => createDitto({ config, sandbox: { ...config.sandbox, tools: store.tools.map(tool => tool.name) }, workers: [
    observed(createContextWorker()), observed(createInferWorker()), observed(createInteractionWorker({ tools: store.tools, output: store.output })),
  ] });
  let runtime = openRuntime();
  const run = () => runners[scenario.mode](runtime, input);
  const request = () => store.request(store.job("task").gateId!);
  const approve = (actor: string, choice: "approve" | "reject" = "approve") => { const r = request(); return store.decide({ requestId: r.id, expectedToken: r.token, choice, actor, note: "Automated acceptance actor representing an authenticated human controller" }); };
  const effects = () => Number(store.db.prepare("SELECT count(*) AS n FROM effects").get()!.n);
  const reopen = async () => { await runtime.close(); store.close(); store = new HumanReviewStore(caseDirectory, reviewers); runtime = openRuntime(); };
  async function edit() {
    const r = request(), previous = store.version("task").draft;
    const replacement = { ...previous, date: "2027-01-15", title: `Human revision ${source.releaseId}`, body: `Human corrected launch instructions for ${source.releaseId}.` };
    const path = join(caseDirectory, "human-edit.json"); await writeFile(path, JSON.stringify(replacement, null, 2));
    store.edit({ requestId: r.id, expectedToken: r.token, replacement: draft(await readJson(path)), actor: scenario.mode === "publish" ? "example-publisher" : "example-editor", note: "Human supplied date and content correction" });
    assert.throws(() => store.decide({ requestId: r.id, expectedToken: r.token, choice: "approve", actor: "example-editor" }), /Stale/);
    return replacement;
  }
  async function child(phase: string) {
    await runtime.close(); store.close();
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/fixtures/human-child.ts", "--directory", caseDirectory, "--phase", phase, "--provider", provider!], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); }); child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    store = new HumanReviewStore(caseDirectory, reviewers); runtime = openRuntime();
    if (phase.endsWith("crash")) assert.equal(outcome.signal, "SIGKILL", outcome.stderr); else assert.equal(outcome.code, 0, outcome.stderr);
    const artifact = await readJson(join(caseDirectory, `child-${phase}.json`)); children.push({ phase, ...outcome, ...artifact }); return artifact;
  }
  const result: Record<string, unknown> = { name: scenario.name, status: "failed", directory: caseDirectory };
  try {
    switch (scenario.name) {
      case "confirm-before-activation": {
        const pending = await run(); assert.equal(effects(), 0); assert.equal((await readJson(join(caseDirectory, "task.deployment.json"))).active, false);
        assert.deepEqual((await readJson(join(caseDirectory, `inbox/${pending.request!.id}.json`))).snapshot, pending.request!.snapshot);
        await assert.rejects(runtime.run(executionGraph, { id: "task", artifact: pending.artifact! }), /approval required/);
        await reopen(); approve("example-operator"); await run(); break;
      }
      case "reject-activation": await run(); approve("example-operator", "reject"); await run(); break;
      case "confirm-intermediate-result":
        await run(); assert.equal(spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length, 1); assert.equal(effects(), 0);
        await assert.rejects(readFile(join(caseDirectory, "private/task.ics")), { code: "ENOENT" }); approve("example-editor"); await run(); break;
      case "edit-confirm-and-continue": {
        await run(); const replacement = await edit(); await reopen(); await run(); assert.equal(effects(), 0); approve("example-editor"); await run();
        assert.deepEqual((await readJson(join(caseDirectory, "private/task.json"))).content, replacement); break;
      }
      case "review-exact-publication": await run(); assert.equal(effects(), 0); approve("example-publisher"); await run(); break;
      case "reject-publication": await run(); approve("example-publisher", "reject"); await run(); break;
      case "editing-invalidates-approval": {
        const first = await run(); approve("example-publisher"); const replacement = await edit();
        await assert.rejects(runtime.run(executionGraph, { id: "task", artifact: first.artifact! }), /approval required/);
        await run(); assert.equal(effects(), 0); approve("example-publisher"); await run();
        assert.deepEqual((await readJson(join(caseDirectory, "published/task.json"))).content, replacement); break;
      }
      case "wrong-role-cannot-approve": await run(); assert.throws(() => approve("example-publisher"), /authorized/); break;
      case "stale-token-cannot-approve": await run(); assert.throws(() => store.decide({ requestId: request().id, expectedToken: "obsolete", choice: "approve", actor: "example-publisher" }), /Stale/); break;
      case "complete-handoff-and-assignment": {
        const handoff = await run(), r = handoff.request!;
        assert.equal(handoff.job.reason, "CONFLICTING_DATES"); assert.deepEqual(r.snapshot.handoff!.sources, source);
        assert.ok(r.snapshot.handoff!.context!.items.length); assert.ok(r.snapshot.handoff!.events.length); assert.deepEqual(r.snapshot.proposal, handoff.artifact!.draft);
        await reopen(); store.claim({ requestId: r.id, expectedToken: r.token, actor: "example-triager", note: "Reconcile the two source dates with the release owner" }); await run(); break;
      }
      case "inbox-failure-and-retry":
        await writeFile(join(caseDirectory, "inbox"), "An existing file prevents creating the review inbox");
        await assert.rejects(run()); assert.equal(request().delivered, false); assert.throws(() => approve("example-operator"), /undelivered/);
        await rm(join(caseDirectory, "inbox")); await reopen(); await run(); approve("example-operator"); await run(); break;
      case "pending-review-process-crash": {
        const first = await child("pending-crash"); assert.equal(first.result.job.stage, "awaiting-review"); assert.equal(effects(), 0);
        approve("example-operator"); const resumed = await child("continue"); assert.notEqual(first.pid, resumed.pid); assert.equal(resumed.modelCalls, 0); break;
      }
      case "edited-version-across-processes":
        await child("pending-crash"); await edit(); await child("edited-review"); approve("example-editor"); assert.equal((await child("continue")).modelCalls, 1); break;
      case "edit-during-downstream-inference": {
        const original = await run(); approve("example-editor");
        onCalendar = () => store.edit({ requestId: original.request!.id, expectedToken: original.request!.token,
          replacement: { ...original.artifact!.draft, title: `Concurrent human correction ${source.releaseId}`, date: "2027-01-15" }, actor: "example-editor", note: "Human update while generation is in progress" });
        await assert.rejects(run(), /approval required/); assert.equal(effects(), 0); await run(); approve("example-editor"); await run(); break;
      }
      case "approved-publish-idempotent-reentry": {
        await run(); approve("example-publisher"); await run(); const before = await readFile(join(caseDirectory, "published/task.json"), "utf8");
        await reopen(); await run(); assert.equal(await readFile(join(caseDirectory, "published/task.json"), "utf8"), before); break;
      }
      case "deployment-drift-blocks-execution":
        await run(); approve("example-operator"); await writeFile(join(caseDirectory, "task.deployment.json"), JSON.stringify({ releaseId: "OTHER-RELEASE", active: false }));
        await assert.rejects(run(), /changed since human review/); assert.equal((await readJson(join(caseDirectory, "task.deployment.json"))).releaseId, "OTHER-RELEASE"); break;
      case "caller-cancelled-before-work": await assert.rejects(runApproval(runtime, input, { signal: AbortSignal.abort(new Error("cancel task")) }), /cancel task/); break;
      case "source-change-before-generation": await writeFile(join(caseDirectory, "task.source.json"), JSON.stringify({ ...source, title: "Changed original source" })); await assert.rejects(run(), /Source changed/); break;
    }
    const saved = await report(runtime, "task"); assert.equal(saved.job.stage, scenario.stage);
    if (saved.artifact) {
      assert.equal(saved.artifact.draft.releaseId, source.releaseId);
      assert.equal(store.version("task", 1).draft.title, source.title); assert.ok(store.version("task", 1).draft.body.includes(source.change));
    }
    if (["awaiting-review", "rejected", "escalated", "queued"].includes(saved.job.stage)) assert.equal(effects(), 0);
    if (saved.job.stage === "completed") {
      assert.equal(effects(), 1); assert.equal(saved.request!.status, "approved");
      if (scenario.mode === "approval") {
        const deployed = await readJson(join(caseDirectory, "task.deployment.json")); assert.equal(deployed.active, true); assert.equal(deployed.releaseId, source.releaseId); assert.equal(deployed.reviewToken, saved.request!.token);
      } else {
        const folder = scenario.mode === "publish" ? "published" : "private";
        const artifact = await readJson(join(caseDirectory, folder, "task.json")); assert.deepEqual(artifact.content, saved.artifact!.draft);
        assert.equal(artifact.digest, digest(saved.artifact!.draft)); assert.equal(artifact.reviewToken, saved.request!.token);
        if (folder === "private") {
          assert.deepEqual(artifact.calendar, { releaseId: source.releaseId, date: saved.artifact!.draft.date, title: saved.artifact!.draft.title });
          assert.ok((await readFile(join(caseDirectory, folder, "task.ics"), "utf8")).includes(saved.artifact!.draft.date.replaceAll("-", "")));
        } else assert.ok((await readFile(join(caseDirectory, folder, "task.md"), "utf8")).includes(saved.artifact!.draft.body));
      }
    }
    const calls = spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length + children.reduce((sum, child) => sum + Number(child.modelCalls), 0);
    assert.equal(calls, scenario.calls); assert.ok(spans.every(span => typeof span.end === "number"));
    const events = store.db.prepare("SELECT seq,kind,data FROM events ORDER BY seq").all();
    await reopen(); assert.deepEqual(store.job("task"), saved.job); assert.deepEqual(await readJson(join(caseDirectory, "results/task.json")), saved);
    if (saved.request) assert.deepEqual(store.request(saved.request.id), saved.request);
    Object.assign(result, { status: "passed", result: saved, events, reopened: true });
  } catch (error) { result.error = error instanceof Error ? error.message : "Unknown human workflow failure"; }
  finally {
    await runtime.close(); store.close();
    Object.assign(result, { spans, children, modelCalls: spans.filter(span => span.node === "INFER.REASONING.SAMPLE").length + children.reduce((sum, child) => sum + Number(child.modelCalls), 0) });
    results.push(result); await writeFile(resolve(values.report!), JSON.stringify({ startedAt, provider, model: modelName, directory, results }, null, 2));
    console.log(JSON.stringify({ name: scenario.name, status: result.status, modelCalls: result.modelCalls, ...(result.error ? { error: result.error } : {}) }));
  }
}
const failed = results.filter(result => result.status !== "passed");
console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, modelCalls: results.reduce((sum, result) => sum + Number(result.modelCalls), 0), directory, report: resolve(values.report!) }, null, 2));
if (failed.length) throw new Error(`${failed.length} human task experiments failed`);
