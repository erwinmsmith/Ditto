import assert from "node:assert/strict";
import test from "node:test";
import {
  evidence,
  view,
  matrix,
  comparison,
  policy,
  synthesis,
  roles,
  topics,
  type Sources,
  type Perspective,
  type Handoff,
} from "../examples/_shared/tools/debate/domain.ts";
const s: Sources = {
  proposalId: "PILOT",
  upliftPercent: 8,
  forecastRevenueCents: 1500000,
  pilotCostCents: 1200000,
  errorBps: 40,
  rollbackVerified: true,
  oncallAssigned: false,
};
function result(agent: Perspective, source = s): Handoff {
  const e = evidence(source, agent),
    v = view(
      {
        agent,
        proposalId: source.proposalId,
        position: "conditional",
        summary: "An independent perspective",
        tradeoff: "Benefit and readiness trade-off",
        assessments: topics.map((topic) => ({
          topic,
          judgment: e.expected[topic],
          reason: "Apply disclosed criteria",
          citations: e.facts[topic],
        })),
      },
      e,
    );
  return { id: String(roles.indexOf(agent) + 1).repeat(64), view: v };
}
function compared(v = roles.map((a) => result(a))) {
  const m = matrix(v);
  return comparison(
    {
      reviewedIds: v.map((x) => x.id),
      summary: "Compare perspectives",
      topics: m.topics.map((t) => ({
        topic: t.topic,
        kind: t.kind,
        summary: "Preserve each role's assessment",
      })),
    },
    v,
  );
}
test("debate retains minority assessments instead of counting a majority as consensus", () => {
  const c = compared();
  assert.equal(c.matrix.topics[0]!.kind, "consensus");
  for (const name of ["cost", "reliability"]) {
    const t = c.matrix.topics.find((t) => t.topic === name)!;
    assert.equal(t.kind, "disagreement");
    assert.equal(
      t.groups.find((g) => g.judgment === "concern")!.agents.length,
      1,
    );
  }
  const views = roles.map((a) => result(a));
  assert.throws(() =>
    comparison(
      { ...c, topics: c.topics.map((t) => ({ ...t, kind: "consensus" })) },
      views,
    ),
  );
  assert.throws(() =>
    comparison({ ...c, reviewedIds: c.reviewedIds.slice(0, 2) }, views),
  );
});
test("debate distinguishes missing perspectives from all-role agreement", () => {
  const c = compared([result("product"), result("finance")]);
  assert.deepEqual(c.matrix.missingAgents, ["reliability"]);
  assert.equal(c.matrix.topics[0]!.kind, "agreement-among-available");
  assert.deepEqual(policy(s, c).allowed, ["defer"]);
});
test("debate binds each perspective to evidence, explicit criteria and its own identity", () => {
  const h = result("finance"),
    e = evidence(s, "finance");
  assert.throws(() => view({ ...h.view, agent: "product" }, e));
  assert.throws(() => view({ ...h.view, position: "support" }, e));
  assert.throws(() =>
    view(
      {
        ...h.view,
        assessments: h.view.assessments.map((a) => ({
          ...a,
          judgment: "positive",
        })),
      },
      e,
    ),
  );
  assert.throws(() =>
    view(
      {
        ...h.view,
        assessments: h.view.assessments.map((a) => ({
          ...a,
          citations: a.citations.map((c) => ({ ...c, quote: "invented" })),
        })),
      },
      e,
    ),
  );
});
test("debate cannot suppress unresolved topics or override readiness gates in synthesis", () => {
  const c = compared(),
    p = policy(s, c),
    out = {
      recommendation: "revise",
      summary: "Address concerns before a new decision",
      conditions: p.unresolvedTopics.map((topic) => ({
        topic,
        action: "Collect evidence and resolve the concern",
      })),
      unresolvedTopics: p.unresolvedTopics,
      missingAgents: [],
    };
  assert.equal(synthesis(out, c, s).comparisonId.length, 64);
  assert.throws(() => synthesis({ ...out, recommendation: "pilot" }, c, s));
  assert.throws(() => synthesis({ ...out, unresolvedTopics: [] }, c, s));
  assert.throws(() => synthesis({ ...out, conditions: [] }, c, s));
});
test("shared unknown cost is consensus about missing evidence, never a pilot approval", () => {
  const missing = { ...s, pilotCostCents: null },
    c = compared(roles.map((a) => result(a, missing)));
  assert.equal(
    c.matrix.topics.find((t) => t.topic === "cost")!.kind,
    "consensus",
  );
  assert.equal(
    c.matrix.topics.find((t) => t.topic === "cost")!.groups[0]!.judgment,
    "unknown",
  );
  assert.deepEqual(policy(missing, c).allowed, ["defer"]);
});
