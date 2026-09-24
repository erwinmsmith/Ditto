import assert from "node:assert/strict";
import test from "node:test";
import {
  decision,
  next,
  initialState,
  evidence,
  finding,
  sources,
  type Request,
  type Sources,
} from "../examples/_shared/tools/supervisor/domain.ts";
const r: Request = {
  id: "task",
  tenant: "demo",
  principal: "operator",
  goal: "Assess readiness",
  sourceDigest: "a".repeat(64),
  maxRounds: 6,
  maxModelCalls: 12,
  maxAgentAttempts: 2,
  deadlineSeconds: 600,
};
const s: Sources = {
  base: {
    releaseId: "REL-204",
    engineering: { total: 50, passed: 48, criticalOpen: 0 },
    operations: { rollbackVerified: true, oncallAssigned: true },
  },
  verification: { runId: "RERUN-205", total: 50, passed: 50, criticalOpen: 0 },
};
const result = (
  agent: "engineering" | "operations" | "verification",
  id: string,
) => {
  const e = evidence(s, agent);
  return {
    resultId: id.repeat(64),
    finding: finding(
      {
        agent,
        assignmentId: `r1-${agent}`,
        releaseId: e.releaseId,
        verdict: e.verdict,
        summary: "Verified facts",
        citations: e.facts,
      },
      e,
      `r1-${agent}`,
    ),
  };
};
test("supervisor validates delegation and cannot finish without specialist evidence", () => {
  const state = initialState();
  assert.deepEqual(next(state, r).eligible, ["engineering", "operations"]);
  const d = {
    action: "delegate",
    reviewedIds: [],
    assignments: [{ agent: "engineering", task: "Check tests" }],
    reason: "Need evidence",
    conclusion: null,
  };
  assert.equal(decision(d, state, r).action, "delegate");
  assert.throws(() =>
    decision(
      {
        ...d,
        assignments: [{ agent: "verification", task: "Skip initial checks" }],
      },
      state,
      r,
    ),
  );
  assert.throws(() =>
    decision(
      { ...d, assignments: [{ agent: "unknown", task: "Do anything" }] },
      state,
      r,
    ),
  );
  assert.throws(() =>
    decision(
      {
        ...d,
        action: "finish",
        assignments: [],
        conclusion: { verdict: "ready", summary: "Trust me", evidenceIds: [] },
      },
      state,
      r,
    ),
  );
});
test("supervisor reassigns based on blockers, reviews all handoffs and preserves lineage", () => {
  const state = initialState();
  state.results.engineering = result("engineering", "a");
  state.results.operations = result("operations", "b");
  assert.deepEqual(next(state, r).eligible, ["verification"]);
  const d = {
    action: "delegate",
    reviewedIds: ["a".repeat(64), "b".repeat(64)],
    assignments: [{ agent: "verification", task: "Read later test record" }],
    reason: "Check initial blocker",
    conclusion: null,
  };
  assert.equal(decision(d, state, r).action, "delegate");
  assert.throws(() => decision({ ...d, reviewedIds: [] }, state, r));
  assert.throws(() =>
    decision(
      { ...d, assignments: [{ agent: "engineering", task: "Repeat" }] },
      state,
      r,
    ),
  );
  state.results.verification = result("verification", "c");
  assert.equal(next(state, r).verdict, "ready");
  const reviewedIds = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const finished = decision(
    {
      action: "finish",
      reviewedIds,
      assignments: [],
      reason: "Reviewed all results",
      conclusion: { verdict: "ready", summary: "Rerun resolved the blocker" },
    },
    state,
    r,
  );
  assert.deepEqual(finished.conclusion!.evidenceIds, reviewedIds);
  assert.equal(state.results.engineering.finding.verdict, "blocked");
  assert.throws(() =>
    decision(
      {
        ...d,
        action: "finish",
        assignments: [],
        conclusion: {
          verdict: "ready",
          summary: "Resolved",
          evidenceIds: d.reviewedIds,
        },
      },
      state,
      r,
    ),
  );
});
test("supervisor escalates missing verification or exhausted specialists instead of inventing success", () => {
  const state = initialState();
  state.attempts.engineering = 2;
  state.results.operations = result("operations", "b");
  assert.equal(next(state, r).escalateAllowed, true);
  assert.equal(
    decision(
      {
        action: "escalate",
        reviewedIds: ["b".repeat(64)],
        assignments: [],
        reason: "Engineering attempts exhausted",
        conclusion: null,
      },
      state,
      r,
    ).action,
    "escalate",
  );
  const missing = evidence({ ...s, verification: null }, "verification");
  assert.equal(missing.verdict, "unknown");
  assert.throws(() =>
    finding(
      {
        agent: "verification",
        assignmentId: "r2-verification",
        releaseId: missing.releaseId,
        verdict: "ready",
        summary: "Invented",
        citations: missing.facts,
      },
      missing,
      "r2-verification",
    ),
  );
});

test("supervisor rejects rerun records with a different test count", () => {
  assert.throws(
    () =>
      sources({
        ...s,
        verification: { ...s.verification, total: 1, passed: 1 },
      }),
    /coverage count/,
  );
});
