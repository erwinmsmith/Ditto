import { createPickupTool } from "../examples/_shared/tools/pickup-ledger.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createInferWorker, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker, type InteractionOutputInput, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { runStateRouting } from "../examples/control-flow/routing/state-routing.ts";
import { runConditional } from "../examples/control-flow/routing/conditional.ts";
import { runBranchMerge } from "../examples/control-flow/routing/branch-merge.ts";
import { runFileType, selectFile, type ParsedFile } from "../examples/control-flow/routing/file-type.ts";
import { runRisk, riskRoute } from "../examples/control-flow/routing/risk.ts";
import { runConfidence, confidenceRoute } from "../examples/control-flow/routing/confidence.ts";
import type { RecordValue, Runner } from "../examples/control-flow/routing/shared.ts";

const value = { code: "PICKUP-unit", quantity: 7 };
const input = { id: "unit", text: "Pickup code PICKUP-unit; quantity 7.", model: { provider: "unit", model: "unit" } };
const response = (data: unknown): SampleOutput => ({ message: { role: "assistant", content: JSON.stringify(data) }, finishReason: "stop" });
// Deterministic edge-case checks. Real HTTP providers are exercised by check:examples:routing:live.
function setup(answer: (call: SampleInput, index: number) => SampleOutput | Promise<SampleOutput>, options: {
  tool?: RegisteredTool; allowTool?: boolean; receipt?: "accepted" | "rejected" | "unknown";
  onDelivery?: () => void;
} = {}) {
  const calls: SampleInput[] = [];
  const graphs: string[] = [];
  const deliveries: InteractionOutputInput[] = [];
  const ledger = new Map<string, RecordValue>();
  const runtime = createDitto({ sandbox: { tools: options.allowTool === false ? [] : ["record_pickup"] }, workers: [
    createInferWorker({ providers: { unit: { async invoke(call) {
      calls.push(call); return answer(call, calls.length - 1);
    } } } }),
    createInteractionWorker({ tools: [options.tool ?? createPickupTool(ledger)], output: { async deliver(item) {
      options.onDelivery?.(); deliveries.push(item);
      return { deliveryId: item.deliveryId, status: options.receipt ?? "accepted",
        ...(options.receipt && options.receipt !== "accepted" ? { error: { code: "DELIVERY_REJECTED", message: "Sink rejected output" } } : {}) };
    } } }),
  ] });
  const observed: Runner = { async run(plan, data, options) {
    graphs.push(plan.id); return runtime.run(plan, data, options);
  } };
  return { runtime, observed, calls, graphs, deliveries, ledger };
}

test("condition routing selects one task graph; blocked state prevents model execution", async () => {
  for (const task of ["extract", "count"] as const) {
    const s = setup(() => response(value));
    try {
      const result = await runStateRouting(s.observed, { ...input, task, state: "ready" });
      assert.equal(result.content.route, task);
      assert.deepEqual(s.graphs, [`condition-${task}`, "routing-delivery"]);
      assert.equal(s.calls.length, 1);
      const blocked = await runStateRouting(s.observed, { ...input, task, state: "blocked" });
      assert.deepEqual(blocked.content, { route: "defer", status: "blocked" });
      assert.equal(s.calls.length, 1);
      await assert.rejects(runStateRouting(s.observed, { ...input, task: "unknown" as "extract", state: "ready" }), /Unknown task/);
    } finally { await s.runtime.close(); }
  }
});

test("conditional branches execute only the model-selected branch and reject invalid decisions", async () => {
  for (const branch of ["priority", "standard", "unknown"] as const) {
    const s = setup((_call, index) => response(index === 0 ? { branch } : value));
    try {
      if (branch === "unknown") {
        await assert.rejects(runConditional(s.observed, input), /Invalid branch decision/);
        assert.deepEqual(s.graphs, ["branch-decision"]);
        assert.equal(s.deliveries.length, 0);
      } else {
        const result = await runConditional(s.observed, input);
        assert.deepEqual(result.content, { route: branch, queue: branch === "priority" ? "expedited" : "normal", ...value });
        assert.deepEqual(s.graphs, ["branch-decision", `branch-${branch}`, "routing-delivery"]);
        assert.equal(s.calls.length, 2);
        assert.equal(s.deliveries.length, 1);
      }
    } finally { await s.runtime.close(); }
  }
});

test("branch merge waits for both independently running branches before one delivery", async () => {
  const completed: string[] = [];
  const s = setup(async call => {
    const owner = String(call.messages[0]?.content).includes("owner");
    await setTimeout(owner ? 20 : 1);
    completed.push(owner ? "owner" : "deadline");
    return response(owner ? { owner: "team" } : { deadline: "2027-01-15" });
  }, { onDelivery() { assert.equal(completed.length, 2); } });
  try {
    const result = await runBranchMerge(s.observed, input);
    assert.deepEqual(completed, ["deadline", "owner"]);
    assert.deepEqual(result.content, { route: "merged", owner: "team", deadline: "2027-01-15" });
    assert.equal(s.deliveries.length, 1);
  } finally { await s.runtime.close(); }
});

test("branch merge does not deliver partial, invalid, or truncated results", async () => {
  for (const deadline of [response({ deadline: "2027-02-30" }), { ...response({ deadline: "2027-01-15" }), finishReason: "length" as const }]) {
    const s = setup(call => String(call.messages[0]?.content).includes("owner") ? response({ owner: "team" }) : deadline);
    try {
      await assert.rejects(runBranchMerge(s.observed, input), /Invalid branch result|Model did not complete/);
      assert.equal(s.calls.length, 2);
      assert.equal(s.deliveries.length, 0);
    } finally { await s.runtime.close(); }
  }
});

const files: ParsedFile[] = [
  { name: "record.PDF", mediaType: "application/pdf", text: input.text },
  { name: "record.csv", mediaType: "text/csv", rows: [["code", "quantity"], [value.code, "7"]] },
  { name: "record.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", rows: [["code", "quantity"], [value.code, "7"]] },
  { name: "record.png", mediaType: "image/png", ocrText: input.text },
  { name: "record.jpeg", mediaType: "image/jpeg", ocrText: input.text },
  { name: "record.wav", mediaType: "audio/wav", transcript: input.text },
  { name: "record.mp3", mediaType: "audio/mpeg", transcript: input.text },
];
test("file metadata selects its handler and passes the adapter's real content without mutation", async () => {
  const s = setup(() => response(value));
  try {
    for (const file of files) {
      const snapshot = structuredClone(file);
      const { route, text } = selectFile(file);
      const result = await runFileType(s.observed, { ...input, file });
      assert.deepEqual(result.content, { route, file: file.name, ...value });
      assert.equal(s.calls.at(-1)?.messages[1]?.content, text);
      assert.deepEqual(s.graphs.slice(-2), [`file-${route}`, "routing-delivery"]);
      assert.deepEqual(file, snapshot);
    }
  } finally { await s.runtime.close(); }
});

test("unsupported, mismatched, empty, and malformed parsed files stop before model calls", async () => {
  const s = setup(() => response(value));
  try {
    for (const file of [
      { name: "record.exe", mediaType: "application/pdf", text: "hello" },
      { name: "record.pdf", mediaType: "application/pdf", text: " " },
      { name: "record.txt", mediaType: "text/plain", text: "hello" },
      { name: "record.csv", mediaType: "text/csv", rows: [["code"], ["x", "y"]] },
      { name: "record.csv", mediaType: "text/csv", rows: [["code"]] },
      { name: "record.png", mediaType: "image/png" },
      { name: "record.wav", mediaType: "audio/wav", transcript: "" },
    ]) await assert.rejects(runFileType(s.observed, { ...input, file: file as ParsedFile }));
    assert.equal(s.calls.length, 0);
    assert.equal(s.deliveries.length, 0);
  } finally { await s.runtime.close(); }
});

test("risk thresholds reject invalid policy values and honor all four boundaries", () => {
  for (const [risk, route] of [[0, "execute"], [24.99, "execute"], [25, "verify"], [49.99, "verify"], [50, "confirm"], [74.99, "confirm"], [75, "human"], [100, "human"]] as const) assert.equal(riskRoute(risk), route);
  for (const risk of [-1, 101, NaN, Infinity]) assert.throws(() => riskRoute(risk), /Risk/);
});

test("risk only executes direct or independently verified requests; all pending routes leave ledger untouched", async () => {
  for (const [risk, verified, status] of [[0, false, "executed"], [25, true, "executed"], [25, false, "pending_human"], [50, true, "pending_confirmation"], [75, true, "pending_human"]] as const) {
    const s = setup(() => response(value));
    let checks = 0;
    try {
      const result = await runRisk(s.observed, { ...input, risk, verify: actual => { checks++; assert.deepEqual(actual, value); return verified; } });
      assert.equal(result.content.status, status);
      assert.equal(checks, risk === 25 ? 1 : 0);
      assert.equal(s.ledger.size, status === "executed" ? 1 : 0);
      assert.equal(s.graphs.includes("risk-execute"), status === "executed");
    } finally { await s.runtime.close(); }
  }
});

test("risk verification errors, tool failures and sandbox denial cannot produce successful delivery", async () => {
  const failed = { ...createPickupTool(new Map()), async execute() { return { status: "failed" as const, error: { code: "FAIL", message: "unavailable" } }; } };
  for (const options of [{ tool: failed }, { allowTool: false }, {}]) {
    const s = setup(() => response(value), options);
    try {
      await assert.rejects(runRisk(s.observed, { ...input, risk: Object.keys(options).length ? 0 : 25,
        verify() { throw new Error("Verifier unavailable"); } }));
      assert.equal(s.deliveries.length, 0);
      assert.equal(s.ledger.size, 0);
    } finally { await s.runtime.close(); }
  }
});

test("risk action is idempotent by request id and rejects conflicting retries", async () => {
  const s = setup((_call, index) => response(index === 2 ? { ...value, quantity: 8 } : value));
  try {
    for (let i = 0; i < 2; i++) await runRisk(s.observed, { ...input, risk: 0, verify: () => false });
    assert.equal(s.ledger.size, 1);
    await assert.rejects(runRisk(s.observed, { ...input, risk: 0, verify: () => false }), /Conflicting/);
    assert.deepEqual(s.ledger.get(input.id), value);
    assert.equal(s.deliveries.length, 2);
  } finally { await s.runtime.close(); }
});

test("confidence boundaries reject invalid scores", () => {
  for (const [score, route] of [[0, "escalate"], [0.3999, "escalate"], [0.4, "retry"], [0.6999, "retry"], [0.7, "analyze"], [0.8999, "analyze"], [0.9, "return"], [1, "return"]] as const) assert.equal(confidenceRoute(score), route);
  for (const score of [-0.01, 1.01, NaN, Infinity]) assert.throws(() => confidenceRoute(score), /Confidence/);
});

test("confidence routes use new evidence or retry original input, reassess once and escalate if unresolved", async () => {
  for (const [score, next, route] of [[0.9, 0.9, "return"], [0.7, 1, "analyze"], [0.4, 1, "retry"], [0.3, 0.3, "escalate"], [0.7, 0.7, "analyze"], [0.4, 0.4, "retry"]] as const) {
    const s = setup(() => response(value));
    const attempts: number[] = [];
    try {
      const result = await runConfidence(s.observed, { ...input, evidence: "authoritative extra evidence", assess: (actual, attempt) => {
        assert.deepEqual(actual, value); attempts.push(attempt); return attempt === 0 ? score : next;
      } });
      assert.equal(result.content.route, route);
      assert.equal(result.content.status, next >= 0.9 ? "returned" : "pending_human");
      const remedied = route === "analyze" || route === "retry";
      assert.deepEqual(attempts, remedied ? [0, 1] : [0]);
      assert.equal(s.calls.length, remedied ? 2 : 1);
      if (route === "analyze") assert.deepEqual(JSON.parse(String(s.calls[1]?.messages[1]?.content)), { candidate: value, evidence: "authoritative extra evidence" });
      if (route === "retry") assert.equal(s.calls[1]?.messages[1]?.content, input.text);
      assert.equal(s.deliveries.length, 1);
    } finally { await s.runtime.close(); }
  }
});

test("invalid confidence assessments, missing evidence and truncated corrections fail without delivery", async () => {
  for (const scenario of ["score", "recheck", "evidence", "truncated"] as const) {
    const s = setup((_call, index) => scenario === "truncated" && index === 1 ? { ...response(value), finishReason: "length" } : response(value));
    try {
      await assert.rejects(runConfidence(s.observed, { ...input, evidence: scenario === "evidence" ? "" : "extra", assess: (_actual, attempt) => {
        return scenario === "score" || (scenario === "recheck" && attempt === 1) ? NaN : 0.7;
      } }));
      assert.equal(s.calls.length, scenario === "score" || scenario === "evidence" ? 1 : 2);
      assert.equal(s.deliveries.length, 0);
    } finally { await s.runtime.close(); }
  }
});

test("failed model responses never trigger subsequent branches or business actions", async () => {
  const s = setup(() => { throw new Error("Provider unavailable"); });
  try {
    await assert.rejects(runConditional(s.observed, input), /Model did not complete/);
    await assert.rejects(runRisk(s.observed, { ...input, risk: 0, verify: () => true }), /Model did not complete/);
    assert.equal(s.calls.length, 2);
    assert.equal(s.ledger.size, 0);
    assert.equal(s.deliveries.length, 0);
  } finally { await s.runtime.close(); }
});

test("delivery rejection is not reported as success; completed side effects require idempotent retry", async () => {
  const s = setup(() => response(value), { receipt: "rejected" });
  try {
    await assert.rejects(runRisk(s.observed, { ...input, risk: 0, verify: () => true }), /Delivery was not accepted/);
    assert.equal(s.ledger.size, 1);
    assert.equal(s.deliveries.length, 1);
  } finally { await s.runtime.close(); }
});
