import { createPickupTool } from "../examples/_shared/tools/pickup-ledger.ts";
/** Real HTTP-model acceptance checks; intentionally excluded from the offline test suite. */
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@ditto/core/runtime";
import { createInferWorker, type NodeResult, type SampleOutput } from "@ditto/core/worker/infer";
import { createInteractionWorker, type InteractionOutputInput } from "@ditto/core/worker/interaction";
import { runStateRouting } from "../examples/control-flow/routing/state-routing.ts";
import { runConditional } from "../examples/control-flow/routing/conditional.ts";
import { runBranchMerge } from "../examples/control-flow/routing/branch-merge.ts";
import { runFileType, type ParsedFile } from "../examples/control-flow/routing/file-type.ts";
import { runRisk } from "../examples/control-flow/routing/risk.ts";
import { runConfidence } from "../examples/control-flow/routing/confidence.ts";
import { json, type RecordValue, type Runner } from "../examples/control-flow/routing/shared.ts";

const { values } = parseArgs({ options: {
  provider: { type: "string" }, report: { type: "string", default: ".examples-routing-live-results.json" },
} });
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider], "Select a configured HTTP provider");
const modelName = config.providers[provider].model ?? (config.model?.provider === provider ? config.model.model : undefined);
assert.ok(modelName, "Configure a model for the selected provider");
const model = { provider, model: modelName };
const deliveries: InteractionOutputInput[] = [];
const ledger = new Map<string, RecordValue>();
const runtime = createDitto({ config, sandbox: { ...config.sandbox, tools: ["record_pickup"] }, workers: [
  createInferWorker(), createInteractionWorker({ tools: [createPickupTool(ledger)], output: { async deliver(input) {
    deliveries.push(input);
    return { deliveryId: input.deliveryId, status: "accepted" };
  } } }),
] });
// Observation only: delegate every call to the actual Runtime and configured HTTP provider.
const graphs: string[] = [];
const samples: NodeResult<SampleOutput>[] = [];
const observed: Runner = { async run(plan, input, options) {
  graphs.push(plan.id);
  const result = await runtime.run(plan, input, options);
  for (const output of Object.values(result)) {
    if (output && typeof output === "object" && "node" in output && output.node === "INFER.REASONING.SAMPLE") {
      samples.push(output as NodeResult<SampleOutput>);
    }
  }
  return result;
} };
const startedAt = new Date().toISOString();
const results: Record<string, unknown>[] = [];
async function check(name: string, expected: unknown, expectedGraphs: string[], expectedCalls: number, run: () => Promise<{ content: unknown }>, expectedWrites = 0) {
  graphs.length = 0; samples.length = 0; deliveries.length = 0; ledger.clear();
  const start = Date.now();
  const report: Record<string, unknown> = { name, expected, status: "failed" };
  console.log(JSON.stringify({ name, event: "started" }));
  try {
    const result = await run();
    report.actual = result.content;
    assert.deepEqual(result.content, expected);
    assert.deepEqual(graphs, expectedGraphs, "Only selected graphs may run");
    assert.equal(samples.length, expectedCalls, "No unselected branch or extra model call");
    assert.equal(deliveries.length, 1, "Exactly one common final delivery");
    assert.deepEqual(deliveries[0]?.message.content, expected);
    assert.equal(ledger.size, expectedWrites, "Pending routes must not execute the business action");
    for (const sample of samples) json(sample);
    report.status = "passed";
  } catch (error) { report.error = error instanceof Error ? error.message : "Unknown failure"; }
  finally {
    Object.assign(report, {
      durationMs: Date.now() - start, graphs: [...graphs], modelCalls: samples.length,
      executions: samples.map(sample => ({ executionId: sample.executionId, status: sample.status,
        finishReason: sample.output?.finishReason, usage: sample.output?.usage })),
      deliveries: deliveries.length, writes: ledger.size,
    });
    results.push(report);
    await writeFile(values.report!, JSON.stringify({
      startedAt, checkedAt: new Date().toISOString(), provider, model: modelName,
      transport: "configured HTTP provider; no injected model responses",
      fileInputBoundary: "parsed PDF text, table rows, OCR text and audio transcripts; binary decoders are application-owned",
      passed: results.filter(item => item.status === "passed").length,
      failed: results.filter(item => item.status === "failed").length, results,
    }, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
}
const request = () => {
  const code = `PICKUP-${randomBytes(6).toString("hex")}`;
  const quantity = randomInt(1, 99);
  return { id: code, model, code, quantity, text: `Pickup code ${code}; quantity ${quantity}.` };
};
const delivery = "routing-delivery";
try {
  for (const task of ["extract", "count"] as const) {
    const input = { ...request(), task, state: "ready" as const };
    const expected = task === "extract" ? { route: task, code: input.code, quantity: input.quantity } : { route: task, quantity: input.quantity };
    await check(`condition-${task}`, expected, [`condition-${task}`, delivery], 1, () => runStateRouting(observed, input));
  }
  await check("condition-blocked", { route: "defer", status: "blocked" }, [delivery], 0,
    () => runStateRouting(observed, { ...request(), task: "extract", state: "blocked" }));
  for (const [level, branch] of [["urgent", "priority"], ["routine", "standard"]] as const) {
    const input = request();
    await check(`branch-${branch}`, { route: branch, queue: branch === "priority" ? "expedited" : "normal", code: input.code, quantity: input.quantity },
      ["branch-decision", `branch-${branch}`, delivery], 2,
      () => runConditional(observed, { ...input, text: `Service level: ${level}. ${input.text}` }));
  }
  const owner = `TEAM-${randomBytes(6).toString("hex")}`;
  const deadline = `2027-03-${String(randomInt(10, 29))}`;
  await check("branch-merge", { route: "merged", owner, deadline }, ["branch-merge"], 2,
    () => runBranchMerge(observed, { id: owner, model, text: `Owner: ${owner}. Deadline: ${deadline}.` }));

  for (const format of ["pdf", "csv", "xlsx", "png", "jpg", "wav", "mp3"] as const) {
    const input = request();
    const name = `${input.id}.${format}`;
    const file: ParsedFile = format === "pdf" ? { name, mediaType: "application/pdf", text: input.text }
      : format === "csv" || format === "xlsx" ? { name, mediaType: format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", rows: [["code", "quantity"], [input.code, String(input.quantity)]] }
      : format === "png" || format === "jpg" ? { name, mediaType: format === "png" ? "image/png" : "image/jpeg", ocrText: input.text }
      : { name, mediaType: format === "wav" ? "audio/wav" : "audio/mpeg", transcript: input.text };
    const route = format === "pdf" ? "pdf" : format === "csv" || format === "xlsx" ? "spreadsheet" : format === "png" || format === "jpg" ? "image" : "audio";
    await check(`file-${format}`, { route, file: name, code: input.code, quantity: input.quantity }, [`file-${route}`, delivery], 1,
      () => runFileType(observed, { id: input.id, model, file }));
  }
  for (const [risk, verified, route, status] of [
    [0, false, "execute", "executed"], [25, true, "verify", "executed"],
    [49, false, "verify", "pending_human"], [50, true, "confirm", "pending_confirmation"], [100, true, "human", "pending_human"],
  ] as const) {
    const input = request();
    const writes = status === "executed" ? 1 : 0;
    let verifiedCalls = 0;
    await check(`risk-${route}-${verified}`, { route, status, code: input.code, quantity: input.quantity },
      ["risk-prepare", ...(writes ? ["risk-execute"] : []), delivery], 1, async () => {
        const output = await runRisk(observed, { ...input, risk, verify: value => {
          verifiedCalls++;
          assert.deepEqual(value, { code: input.code, quantity: input.quantity });
          return verified;
        } });
        assert.equal(verifiedCalls, route === "verify" ? 1 : 0);
        assert.equal(output.toolCalls, writes);
        if (writes) assert.deepEqual(ledger.get(input.id), { code: input.code, quantity: input.quantity });
        return output;
      }, writes);
  }
  for (const [initialScore, finalScore, route] of [
    [0.9, 0.9, "return"], [0.7, 1, "analyze"], [0.4, 1, "retry"], [0.39, 0.39, "escalate"],
    [0.8, 0.8, "analyze"], [0.5, 0.5, "retry"],
  ] as const) {
    const input = request();
    const corrected = route === "analyze" || route === "retry";
    const expectedQuantity = route === "analyze" ? input.quantity + 1 : input.quantity;
    const attempts: number[] = [];
    await check(`confidence-${route}-${finalScore}`, {
      route, status: finalScore >= 0.9 ? "returned" : "pending_human", score: finalScore, code: input.code, quantity: expectedQuantity,
    }, ["confidence-initial", ...(corrected ? [`confidence-${route}`] : []), delivery], corrected ? 2 : 1, async () => {
      const output = await runConfidence(observed, {
        ...input, evidence: `Pickup code ${input.code}; quantity ${expectedQuantity}.`,
        assess: (value, attempt) => {
          attempts.push(attempt);
          assert.deepEqual(value, { code: input.code, quantity: attempt === 0 ? input.quantity : expectedQuantity });
          // Trusted fixture scores exercise policy thresholds; they are not model confidence claims.
          return attempt === 0 ? initialScore : finalScore;
        },
      });
      assert.deepEqual(attempts, corrected ? [0, 1] : [0]);
      return output;
    });
  }
} finally { await runtime.close(); }
assert.equal(results.length, 24);
if (results.some(item => item.status !== "passed")) process.exitCode = 1;
