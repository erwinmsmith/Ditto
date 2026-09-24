import assert from "node:assert/strict";
import test from "node:test";
import {
  request,
  route,
  evidence,
  plan,
  answer,
  type Sources,
} from "../examples/_shared/tools/specialist-routing/domain.ts";
const r = request({
  id: "task",
  tenant: "demo",
  principal: "operator",
  question: "Query sales",
  sourceDigest: "a".repeat(64),
  allowedRoles: ["finance", "legal", "data", "coding"],
  minConfidence: 0.75,
  maxModelCalls: 8,
  maxAttempts: 2,
  deadlineSeconds: 600,
});
const selected = {
  domains: ["data"],
  intent: "sales-summary",
  confidence: 0.9,
  reason: "Database aggregation",
  question: null,
};
test("specialist routing admits one known allowed domain and consistent intent", () => {
  assert.equal(route(selected, r).selected, "data");
  assert.throws(() => route({ ...selected, domains: ["unknown"] }, r));
  assert.throws(() => route({ ...selected, intent: "reimbursement" }, r));
  assert.throws(() => route({ ...selected, domains: ["data", "data"] }, r));
  assert.equal(
    route(selected, { ...r, allowedRoles: ["coding"] }).status,
    "unavailable",
  );
});
test("specialist routing requires clarification for ambiguity, unsupported tasks and low confidence", () => {
  for (const v of [
    { ...selected, domains: ["data", "coding"], intent: null },
    { ...selected, domains: [], intent: null },
    { ...selected, confidence: 0.4 },
  ]) {
    assert.throws(() => route(v, r));
    const routed = route(
      { ...v, question: "Which single task should be handled?" },
      r,
    );
    assert.equal(routed.status, "needs-clarification");
    assert.equal(routed.selected, null);
  }
});
const s: Sources = {
  codeDigest: "b".repeat(64),
  finance: {
    claimId: "EXP",
    mealCents: 58000,
    travelCents: 12000,
    mealCapCents: 50000,
  },
  legal: {
    contractId: "C1",
    noticeDays: 30,
    requiredNoticeDays: 30,
    dataReturnDays: null,
  },
  data: [{ id: "S1", region: "north", cents: 120000, status: "paid" }],
};
test("specialist plan is limited to its selected role, operation and exact evidence", () => {
  const e = evidence(s, "data"),
    p = {
      matchesRequest: true,
      role: e.role,
      intent: e.intent,
      action: e.action,
      target: e.target,
      summary: "Aggregate paid rows",
      citations: e.facts,
    };
  assert.equal(plan(p, e).action, "query-sales");
  assert.throws(() => plan({ ...p, matchesRequest: false }, e));
  assert.throws(() => plan({ ...p, role: "finance" }, e));
  assert.throws(() => plan({ ...p, action: "delete-sales" }, e));
  assert.throws(() =>
    plan(
      { ...p, citations: e.facts.map((c) => ({ ...c, quote: "invented" })) },
      e,
    ),
  );
  assert.ok(!JSON.stringify(e).includes("EXP"));
  assert.ok(!JSON.stringify(e).includes("contractId"));
});
test("specialist answer checks nested executed values without depending on JSON property order", () => {
  const result = {
    role: "data" as const,
    values: { count: 1, regions: [{ region: "north", cents: 120000 }] },
    facts: [{ id: "result", quote: "One paid sale" }],
  };
  const a = {
    role: "data",
    summary: "One sale",
    values: { regions: [{ cents: 120000, region: "north" }], count: 1 },
    citations: result.facts,
  };
  assert.equal(answer(a, result).values.count, 1);
  assert.throws(() =>
    answer(
      {
        ...a,
        values: { ...a.values, regions: [{ cents: 1, region: "north" }] },
      },
      result,
    ),
  );
  assert.throws(() => answer({ ...a, role: "finance" }, result));
});
