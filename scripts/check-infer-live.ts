/** Explicit opt-in integration check. Uses configured real providers; never part of npm test. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDitto, createInfer, createInferWorker, defineWorker, graph, loadRuntimeConfigFile, runReactFlow } from "@ditto/core";
import type { Infer } from "@ditto/core";
const { values } = parseArgs({ options: { provider: { type: "string" }, report: { type: "string", default: ".infer-live-results.json" }, strategies: { type: "string" }, cases: { type: "string" }, label: { type: "string" }, "max-tokens": { type: "string" } } });
const config = loadRuntimeConfigFile();
const maxTokens = Number(values["max-tokens"] ?? config.infer.generation?.maxTokens); assert.ok(Number.isSafeInteger(maxTokens) && maxTokens >= 256 && maxTokens <= 16384, "max-tokens must be 256..16384");
const generation = values["max-tokens"] ? { maxTokens } : {};
const selected = values.provider?.split(",") ?? Object.keys(config.providers);
const strategies = values.strategies?.split(",") ?? ["cot", "long-cot", "tot", "got", "self-consistency"];
const startedAt = new Date().toISOString();
let previousRuns: unknown[] = [];
try { const previous = JSON.parse(await readFile(values.report!, "utf8")) as { runs?: unknown[] }; previousRuns = previous.runs ?? [previous]; }
catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
const reports: { provider: string; model: string; case: string; status: string; ms: number; answer?: unknown; usage?: Infer.Usage | undefined; modelCalls?: number; detail?: string }[] = [];
async function save() {
  await writeFile(values.report!, JSON.stringify({ runs: [...previousRuns, { startedAt, checkedAt: new Date().toISOString(),
    label: values.label ?? "Real provider verification", providers: selected, strategies, cases: values.cases, maxTokens,
    settings: { runtime: { timeoutMs: config.timeoutMs, maxTurns: config.maxTurns }, infer: config.infer, react: config.react },
    results: reports }] }, null, 2) + "\n");
}
function output<T>(result: Infer.NodeResult<T>): T { assert.equal(result.status, "success", result.error?.message); assert.ok(result.output); return result.output; }
function json(message: Infer.Message): Record<string, unknown> {
  assert.equal(message.role, "assistant"); assert.equal(typeof message.content, "string");
  return JSON.parse(String(message.content).trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as Record<string, unknown>;
}
const tasks = [
  { name: "arithmetic", prompt: 'A shop sells 3 notebooks at 12 yuan each and 2 pens at 4 yuan each. Apply a 25% discount to the whole order; the customer pays 50 yuan. Return ONLY a JSON object with numeric fields total and change.', verify(message: Infer.Message) { assert.deepEqual(json(message), { total: 33, change: 17 }); } },
  { name: "shortest-path", prompt: 'In this directed graph, edges are A->B=4, A->C=2, C->B=1, B->D=2, C->D=6. Find the cheapest route from A to D. Return ONLY JSON with path (array of node names) and cost (number).', verify(message: Infer.Message) { assert.deepEqual(json(message), { path: ["A", "C", "B", "D"], cost: 5 }); } },
];
for (const name of selected) {
  const provider = config.providers[name]; assert.ok(provider, `Provider not configured: ${name}`);
  const modelName = provider.model ?? (name === config.model?.provider ? config.model.model : undefined);
  assert.ok(modelName, `Set DITTO_SHARED_PROVIDER_${name.toUpperCase()}_MODEL`);
  const model = { provider: name, model: modelName };
  const runtime = createDitto({ config, workers: [createInferWorker()] });
  const infer = createInfer({ runtime });
  const runCase = async (label: string, fn: () => Promise<{ answer?: unknown; usage?: Infer.Usage | undefined; modelCalls?: number }>) => {
    if (values.cases && !values.cases.split(",").some(filter => label === filter || label.startsWith(filter + "/"))) return true;
    const start = Date.now();
    try { const details = await fn(); reports.push({ provider: name, model: modelName, case: label, status: "passed", ms: Date.now() - start, ...details }); }
    catch (error) { reports.push({ provider: name, model: modelName, case: label, status: "failed", ms: Date.now() - start, detail: error instanceof Error ? error.message : "Unknown failure" }); }
    await save(); const result = reports.at(-1)!; console.log(JSON.stringify(result)); return result.status === "passed";
  };
  try {
    const connected = await runCase("sample", async () => {
      const result = output(await runtime.run(graph<Infer.SampleInput>("live-sample").node("sample", "INFER.REASONING.SAMPLE", [], i => i), {
        model, messages: [{ role: "user", content: "Compute 17 * 23. Reply with only the integer." }], generation,
      }).then(r => r.sample));
      assert.equal(String(result.message.content).trim(), "391"); assert.equal(result.finishReason, "stop");
      return { answer: { role: result.message.role, content: result.message.content }, usage: result.usage, modelCalls: 1 };
    });
    if (!connected) continue;
    for (const strategy of strategies) for (const task of tasks) await runCase(`${strategy}/${task.name}`, async () => {
      const result = output(await runtime.invoke("INFER.REASONING.TRAJECTORY", {
        model, messages: [{ role: "user", content: task.prompt }], strategy: { name: strategy }, generation,
      }));
      assert.equal(result.status, "completed", result.stopReason); task.verify(result.result);
      const seen = new Set<string>(); for (const step of result.steps) { for (const parent of step.parentIds ?? []) assert.ok(seen.has(parent), "Unknown parent step"); seen.add(step.id); }
      return { answer: result.result, usage: result.usage, modelCalls: result.steps.filter(s => s.type === "model").length };
    });
    for (const mode of ["critique", "verify", "revise"] as const) await runCase(`reflect/${mode}`, async () => {
      const result = output(await runtime.invoke("INFER.REASONING.REFLECT", {
        model, messages: [{ role: "user", content: "Compute 17 * 23. The correct answer must be the integer only." }],
        target: { result: { role: "assistant", content: "400" } }, mode, generation,
        criteria: [{ id: "arithmetic", description: "Verify the multiplication independently. Flag arithmetic errors and fix the answer in revise mode." }],
      }));
      assert.ok(result.issues.length); if (mode === "verify") assert.equal(result.assessment.passed, false);
      if (mode === "revise") assert.equal(String(result.revisedResult?.content).trim(), "391");
      return { answer: result, usage: result.usage, modelCalls: 1 };
    });
    for (const mode of ["select", "merge", "consensus", "debate"] as const) await runCase(`deliberate/${mode}`, async () => {
      const result = output(await runtime.invoke("INFER.REASONING.DELIBERATE", {
        model, messages: [{ role: "user", content: "Compute 17 * 23. Return only the integer, without explanation." }],
        candidates: [{ id: "correct", result: { role: "assistant", content: "391" } }, { id: "wrong", result: { role: "assistant", content: "400" } }], mode, generation,
      }));
      assert.equal(String(result.result.content).trim(), "391"); if (mode === "select") assert.deepEqual(result.selectedCandidateIds, ["correct"]);
      return { answer: result.result, usage: result.usage, modelCalls: 1 };
    });
    await runCase("deliberate/defaults", async () => {
      const result = output(await infer.reasoning.deliberate({
        model, messages: [{ role: "user", content: "Compute 17 * 23. Return only the integer." }],
        candidates: [{ id: "correct", result: { role: "assistant", content: "391" } }, { id: "wrong", result: { role: "assistant", content: "400" } }],
      }));
      assert.equal(String(result.result.content).trim(), "391");
      if ((config.infer.deliberate?.mode ?? "select") === "select") assert.equal(result.selectedCandidateIds?.[0], "correct");
      return { answer: result.result, usage: result.usage, modelCalls: 1 };
    });
    for (const name of ["sample", "trajectory"] as const) await runCase(`${name}/stream`, async () => {
      const request = { model, messages: [{ role: "user" as const, content: "Compute 17 * 23. Reply with only the integer." }], generation };
      const events = name === "sample" ? infer.reasoning.sample.stream(request) : infer.reasoning.trajectory.stream({ ...request, strategy: { name: "cot" } });
      let delta = ""; let terminal = 0; let answer: Infer.Message | undefined; let usage: Infer.Usage | undefined;
      for await (const event of events) {
        if (event.type === "text_delta") delta += event.delta;
        if (event.type === "result") { terminal++; assert.equal(event.result.status, "success"); const value = event.result.output!; answer = "message" in value ? value.message : value.result; usage = value.usage; }
      }
      assert.equal(terminal, 1); assert.ok(delta.length); assert.equal(String(answer?.content).trim(), "391"); return { answer, usage };
    });
    let calls = 0;
    runtime.register(defineWorker({ type: "INTERACTION", nodes: { "INTERACTION.ACT.TOOL": async ({ call }) => { calls++; assert.equal(call.name, "lookup_code"); assert.equal(call.arguments.label, "alpha"); return { source: "fixture", content: "ORCHID-731" }; } } }));
    await runCase("react/tool-roundtrip", async () => {
      const result = await runReactFlow(runtime, { model, messages: [{ role: "user", content: 'Call lookup_code with label="alpha" to retrieve its unknown code. Then reply with only the returned code.' }],
        actions: [{ name: "lookup_code", description: "Look up a code by label", inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }], generation, constraints: { maxSteps: 3, maxActionCalls: 1 } });
      assert.equal(result.status, "completed", result.error?.message); assert.equal(calls, 1); assert.equal(String(result.result.content).trim(), "ORCHID-731"); return { answer: result.result, usage: result.usage, modelCalls: result.samples.length };
    });
    await runCase("cache/roundtrip", async () => {
      const key = { namespace: "live", scope: "sample", key: name }; const message = { role: "assistant", content: "391" };
      output(await runtime.invoke("INFER.CACHE.WRITE", { key, value: message, ttlMs: 1000 }));
      assert.deepEqual(output(await runtime.invoke("INFER.CACHE.LOOKUP", { key })).value, message);
      assert.equal(output(await runtime.invoke("INFER.CACHE.INVALIDATE", { selector: { type: "key", key } })).invalidated, 1);
      assert.equal(output(await runtime.invoke("INFER.CACHE.LOOKUP", { key })).hit, false); return { modelCalls: 0 };
    });
  } finally { await runtime.close(); }
  await save();
}
await save();
console.log(JSON.stringify({ passed: reports.filter(r => r.status === "passed").length, failed: reports.filter(r => r.status === "failed").length, report: values.report }));
assert.ok(reports.length > 0, "No live cases matched the requested filters");
if (reports.some(r => r.status === "failed")) process.exitCode = 1;
