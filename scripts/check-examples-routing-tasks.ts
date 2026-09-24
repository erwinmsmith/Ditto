/** Task acceptance: physical inputs, actual tools, HTTP inference, durable effects and reopened artifacts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker, type NodeResult, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker } from "@ditto/core/worker/interaction";
import { createFileTools } from "../examples/_shared/tools/file-ingestion/index.ts";
import { PickupTaskStore } from "../examples/_shared/tools/pickup-task-store.ts";
import { runStateRouting } from "../examples/control-flow/routing/state-routing.ts";
import { runConditional } from "../examples/control-flow/routing/conditional.ts";
import { runBranchMerge } from "../examples/control-flow/routing/branch-merge.ts";
import { runFileTask } from "../examples/control-flow/routing/file-type.ts";
import { runRisk, resumeRisk } from "../examples/control-flow/routing/risk.ts";
import { runConfidence } from "../examples/control-flow/routing/confidence.ts";
import { type Runner, type RecordValue } from "../examples/control-flow/routing/shared.ts";

const { values } = parseArgs({ options: {
  provider: { type: "string" }, python: { type: "string" },
  report: { type: "string", default: ".examples-routing-tasks-live-results.json" },
  "output-dir": { type: "string", default: ".examples-routing-tasks" },
} });
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider], "Select a configured HTTP provider");
const modelName = config.providers[provider].model ?? (config.model?.provider === provider ? config.model.model : undefined);
assert.ok(modelName);
const model = { provider, model: modelName };
const python = resolve(values.python ?? process.env.DITTO_EXAMPLE_TOOLS_PYTHON ?? "examples/_shared/tools/.venv/bin/python");
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const inputDirectory = join(directory, "input");
await promisify(execFile)(python, [fileURLToPath(new URL("./fixtures/routing-files.py", import.meta.url)), inputDirectory], { timeout: 120_000 });
console.log(`Task artifacts: ${directory}`);
const store = new PickupTaskStore(directory);
const tools = [...createFileTools({ root: inputDirectory, python,
  pdftotext: process.env.DITTO_EXAMPLE_PDFTOTEXT ?? "pdftotext", tesseract: process.env.DITTO_EXAMPLE_TESSERACT ?? "tesseract",
  asrModel: process.env.DITTO_EXAMPLE_ASR_MODEL ?? "tiny.en",
}), store.tool];
const toolCalls: { name: string; status: string }[] = [];
const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: tools.map(tool => tool.name) }, workers: [
  createInferWorker(), createInteractionWorker({ output: store.output, tools: tools.map(tool => ({ ...tool,
    async execute(args, context) {
      try { const result = await tool.execute(args, context); toolCalls.push({ name: tool.name, status: result.status }); return result; }
      catch (error) { toolCalls.push({ name: tool.name, status: "threw" }); throw error; }
    },
  })) }),
] });
const graphs: string[] = [];
const samples: NodeResult<SampleOutput>[] = [];
const observed: Runner = { async run(plan, input, options) {
  graphs.push(plan.id);
  const result = await runtime.run(plan, input, options);
  for (const output of Object.values(result)) if (output && typeof output === "object" && "node" in output && output.node === "INFER.REASONING.SAMPLE") samples.push(output as NodeResult<SampleOutput>);
  return result;
} };
const results: Record<string, unknown>[] = [];
const expectedTasks = new Map<string, { status: string; content: unknown; pickup?: RecordValue }>();
const startedAt = new Date().toISOString();
async function artifact(id: string, expected: unknown, status = "completed") {
  const file = JSON.parse(await readFile(join(directory, "deliveries", `${id}.json`), "utf8"));
  assert.deepEqual(file, { taskId: id, status, content: expected });
  assert.equal(store.task(id).status, status);
  assert.deepEqual(JSON.parse(store.task(id).outcome!), expected);
  expectedTasks.set(id, { status, content: expected });
}
async function check(name: string, run: () => Promise<Record<string, unknown>>) {
  graphs.length = 0; samples.length = 0; toolCalls.length = 0;
  const start = Date.now();
  const report: Record<string, unknown> = { name, status: "failed" };
  console.log(JSON.stringify({ name, event: "started" }));
  try { Object.assign(report, await run()); report.status = "passed"; }
  catch (error) { report.error = error instanceof Error ? error.message : "Unknown failure"; }
  finally {
    Object.assign(report, { durationMs: Date.now() - start, graphs: [...graphs], toolCalls: [...toolCalls],
      modelCalls: samples.length, executions: samples.map(sample => ({ executionId: sample.executionId, status: sample.status, usage: sample.output?.usage })) });
    results.push(report);
    await writeFile(values.report!, JSON.stringify({ startedAt, checkedAt: new Date().toISOString(), provider, model: modelName,
      directory, database: join(directory, "tasks.sqlite"), reviewActor: "automated acceptance reviewer (not a real human)",
      passed: results.filter(row => row.status === "passed").length, failed: results.filter(row => row.status !== "passed").length, results }, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
}
async function request(id: string) {
  const value = { code: `PICKUP-${randomBytes(4).toString("hex")}`, quantity: randomInt(2, 30) };
  const path = join(inputDirectory, `${id}.json`);
  await writeFile(path, JSON.stringify({ id, text: `Pickup code ${value.code}; quantity ${value.quantity}.` }));
  const persisted = JSON.parse(await readFile(path, "utf8")) as { id: string; text: string };
  return { input: { ...persisted, model }, value, path };
}
try {
  for (const task of ["extract", "count"] as const) await check(`task-condition-${task}`, async () => {
    const id = `condition-${task}`;
    const { input, value, path } = await request(id);
    store.create(id, "condition");
    await runStateRouting(observed, { ...input, task, state: "ready" });
    const expected = task === "extract" ? { route: task, ...value } : { route: task, quantity: value.quantity };
    await artifact(id, expected);
    assert.deepEqual(graphs, [`condition-${task}`, "routing-delivery"]);
    return { taskId: id, inputFile: path, expected, taskStatus: store.task(id).status };
  });
  await check("task-blocked-resume", async () => {
    const id = "blocked-resume";
    const { input, value } = await request(id);
    store.create(id, "condition");
    await runStateRouting(observed, { ...input, task: "extract", state: "blocked" });
    await artifact(id, { route: "defer", status: "blocked" }, "blocked");
    assert.equal(samples.length, 0);
    await runStateRouting(observed, { ...input, task: "extract", state: "ready" });
    await artifact(id, { route: "extract", ...value });
    return { taskId: id, transitions: ["queued", "blocked", "completed"] };
  });
  for (const [level, route, queue] of [["urgent", "priority", "expedited"], ["routine", "standard", "normal"]] as const) await check(`task-branch-${route}`, async () => {
    const id = `branch-${route}`;
    const { input, value } = await request(id);
    store.create(id, "dispatch");
    await runConditional(observed, { ...input, text: `Service level: ${level}. ${input.text}` });
    await artifact(id, { route, queue, ...value });
    assert.deepEqual(graphs, ["branch-decision", `branch-${route}`, "routing-delivery"]);
    return { taskId: id, dispatchQueue: queue, taskStatus: "completed" };
  });
  await check("task-branch-merge", async () => {
    const id = "handoff";
    const owner = `TEAM-${randomBytes(4).toString("hex")}`;
    const deadline = "2027-04-17";
    const path = join(inputDirectory, "handoff.txt");
    await writeFile(path, `Owner: ${owner}. Deadline: ${deadline}.`);
    store.create(id, "handoff");
    await runBranchMerge(observed, { id, model, text: await readFile(path, "utf8") });
    await artifact(id, { route: "merged", owner, deadline });
    assert.equal(samples.length, 2);
    return { taskId: id, artifact: join(directory, "deliveries/handoff.json"), expected: { owner, deadline } };
  });
  const files = JSON.parse(await readFile(join(inputDirectory, "manifest.json"), "utf8")) as { name: string; mediaType: string; code: string; quantity: number }[];
  for (const file of files) await check(`task-file-${file.name}`, async () => {
    const id = `file-${file.name.replaceAll(".", "-")}`;
    const path = join(inputDirectory, file.name);
    store.create(id, "file-extraction");
    // Expected answers remain in this runner; only path/MIME/name reach the actual parser.
    const result = await runFileTask(observed, { id, model, file: { path, name: file.name, mediaType: file.mediaType } });
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    assert.equal((result.parsed as Record<string, unknown>).sourceSha256, digest);
    const route = file.mediaType === "application/pdf" ? "pdf" : file.mediaType.startsWith("image/") ? "image" : file.mediaType.startsWith("audio/") ? "audio" : "spreadsheet";
    await artifact(id, { route, file: file.name, code: file.code, quantity: file.quantity });
    assert.deepEqual(graphs, ["file-ingestion", `file-${route}`, "routing-delivery"]);
    assert.equal(toolCalls.length, 1);
    return { taskId: id, inputFile: path, sourceSha256: digest, parsed: result.parsed, taskStatus: "completed" };
  });
  for (const [id, risk, verified, decision] of [
    ["risk-direct", 0, true, null], ["risk-verify", 30, true, null], ["risk-verify-review", 30, false, "approve"],
    ["risk-confirm", 60, true, "approve"], ["risk-rejected", 60, true, "reject"], ["risk-human", 90, true, "approve"],
  ] as const) await check(id, async () => {
    const { input, value } = await request(id);
    store.create(id, "risk", risk);
    if (verified) store.addReference(value);
    const result = await runRisk(observed, { ...input, risk, verify: actual => store.verify(actual) });
    if (decision) {
      const pendingStatus = risk >= 50 && risk < 75 ? "pending_confirmation" : "pending_human";
      await artifact(id, { route: result.content.route, status: pendingStatus, ...value }, pendingStatus);
      assert.equal(store.pickup(id), undefined);
      assert.equal(toolCalls.length, 0);
      await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: { id, name: "record_pickup", arguments: { id, ...value } } }), /not authorized/);
      await store.review(id, decision, "acceptance-reviewer");
      assert.equal(store.authorized(id, { ...value, quantity: value.quantity + 1 }), false, "Approval must bind the exact payload");
      const resume = () => resumeRisk(observed, { id, value, route: result.content.route as "confirm" | "human" | "verify", authorize: (id, value) => store.authorized(id, value) });
      if (decision === "reject") {
        await assert.rejects(resume(), /authorization/);
        assert.equal(store.pickup(id), undefined);
        assert.equal(store.task(id).status, "rejected");
        await artifact(id, { route: result.content.route, status: "rejected", ...value }, "rejected");
        return { taskId: id, review: decision, finalStatus: "rejected", businessWrites: 0 };
      }
      await resume();
      // A retry after successful completion must not insert another business record.
      await resume();
    }
    const expected = { route: result.content.route, status: "executed", ...value };
    await artifact(id, expected);
    assert.deepEqual({ ...store.pickup(id) }, value);
    expectedTasks.set(id, { status: "completed", content: expected, pickup: value });
    return { taskId: id, review: decision, finalStatus: "completed", persistedPickup: value };
  });
  for (const [id, initialSources, resolvedSources, route] of [
    ["confidence-return", 5, 5, "return"], ["confidence-analyze", 4, 5, "analyze"],
    ["confidence-retry", 2, 5, "retry"], ["confidence-escalate", 1, 1, "escalate"],
    ["confidence-analysis-unresolved", 4, 4, "analyze"], ["confidence-retry-unresolved", 2, 2, "retry"],
  ] as const) await check(id, async () => {
    const { input, value } = await request(id);
    store.create(id, "reconciliation");
    const references: string[] = [];
    for (let index = 0; index < 5; index++) {
      const path = join(inputDirectory, `${id}-reference-${index}.json`);
      await writeFile(path, JSON.stringify(index < resolvedSources ? value : { ...value, quantity: value.quantity + 1 }));
      references.push(path);
    }
    const assessments: unknown[] = [];
    await runConfidence(observed, { ...input, evidence: await readFile(references[0]!, "utf8"), assess: async (candidate, attempt) => {
      const paths = attempt === 0 ? references.slice(0, initialSources) : references;
      const checked = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8")) as RecordValue));
      const matches = checked.filter(reference => reference.code === candidate.code && reference.quantity === candidate.quantity).length;
      const score = matches / references.length;
      assessments.push({ attempt, checkedFiles: paths, matches, requiredSources: references.length, score });
      return score;
    } });
    const score = (route === "return" || route === "escalate" ? initialSources : resolvedSources) / 5;
    const status = score >= 0.9 ? "returned" : "pending_human";
    await artifact(id, { route, status, score, ...value }, status === "returned" ? "completed" : "pending_human");
    assert.equal(samples.length, route === "analyze" || route === "retry" ? 2 : 1);
    return { taskId: id, assessments, finalStatus: store.task(id).status };
  });
  await check("task-corrupt-file", async () => {
    const id = "corrupt-file";
    const path = join(inputDirectory, "corrupt.pdf");
    await writeFile(path, "This is not a PDF file");
    store.create(id, "file-extraction");
    await assert.rejects(runFileTask(observed, { id, model, file: { path, name: "corrupt.pdf", mediaType: "application/pdf" } }));
    assert.equal(samples.length, 0);
    await store.fail(id, "FILE_PARSE_FAILED");
    await artifact(id, { route: "error", status: "failed", error: "FILE_PARSE_FAILED" }, "failed");
    return { taskId: id, parserRejected: true, modelCalls: 0, finalStatus: "failed" };
  });
  await runtime.close();
  store.close();
  await check("task-reopen-persistence", async () => {
    const reopened = new PickupTaskStore(directory);
    try {
      for (const [id, expected] of expectedTasks) {
        const task = reopened.task(id);
        assert.equal(task.status, expected.status);
        assert.deepEqual(JSON.parse(task.outcome!), expected.content);
        if (expected.pickup) assert.deepEqual({ ...reopened.pickup(id) }, expected.pickup);
      }
      const count = reopened.db.prepare("SELECT COUNT(*) AS count FROM pickups").get()?.count;
      assert.equal(count, 5, "Only authorized tasks produce durable business rows, including retries");
      return { reopenedTasks: expectedTasks.size, durablePickups: count, database: join(directory, "tasks.sqlite") };
    } finally { reopened.close(); }
  });
} finally {
  await runtime.close();
  // The store may already have been closed for the restart check.
  if (store.db.isOpen) store.close();
}
assert.equal(results.length, 27);
if (results.some(row => row.status !== "passed")) process.exitCode = 1;
