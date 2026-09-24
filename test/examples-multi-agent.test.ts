import assert from "node:assert/strict";
import test from "node:test";
import {
  request,
  plan,
  evidence,
  finding,
  summary,
  type Sources,
  type Request,
} from "../examples/_shared/tools/multi-agent/domain.ts";
const r: Request = {
  id: "task",
  tenant: "demo",
  principal: "operator",
  goal: "Assess release readiness",
  sourceDigest: "a".repeat(64),
  mode: "parallel",
  maxModelCalls: 7,
  maxAgentAttempts: 2,
  deadlineSeconds: 600,
};
const source: Sources = {
  releaseId: "REL-204",
  engineering: { total: 50, passed: 48, criticalOpen: 0 },
  operations: { rollbackVerified: true, oncallAssigned: true },
};
const p = {
  tasks: [
    {
      id: "engineering",
      agent: "engineering",
      goal: "Check tests",
      dependsOn: [],
    },
    {
      id: "operations",
      agent: "operations",
      goal: "Check operations",
      dependsOn: [],
    },
    {
      id: "synthesis",
      agent: "synthesis",
      goal: "Combine results",
      dependsOn: ["engineering", "operations"],
    },
  ],
};
test("multi-agent validates registered roles, unique assignments and exact dependencies", () => {
  assert.deepEqual(plan(p, r), p);
  assert.throws(() => plan({ ...p, tasks: [...p.tasks, p.tasks[0]] }, r));
  for (const patch of [
    { agent: "unregistered" },
    { dependsOn: ["operations"] },
    { id: "operations", agent: "operations" },
  ])
    assert.throws(() =>
      plan(
        { tasks: p.tasks.map((t, i) => (i === 0 ? { ...t, ...patch } : t)) },
        r,
      ),
    );
  assert.throws(() => plan(p, { ...r, mode: "serial" }));
  assert.equal(
    plan(
      {
        tasks: p.tasks.map((t) =>
          t.id === "operations" ? { ...t, dependsOn: ["engineering"] } : t,
        ),
      },
      { ...r, mode: "serial" },
    ).tasks[1]!.dependsOn[0],
    "engineering",
  );
  assert.throws(() => request({ ...r, maxAgentAttempts: 4 }));
});
test("multi-agent specialist evidence cannot cross roles or erase blockers", () => {
  const e = evidence(source, "engineering"),
    result = {
      agent: "engineering",
      taskId: "engineering",
      releaseId: source.releaseId,
      verdict: "blocked",
      summary: "Two tests failed",
      citations: e.facts,
    };
  assert.equal(finding(result, e).verdict, "blocked");
  assert.throws(() => finding({ ...result, agent: "operations" }, e));
  assert.throws(() => finding({ ...result, verdict: "ready" }, e));
  assert.throws(() =>
    finding({ ...result, citations: [e.facts[0], e.facts[0]] }, e),
  );
  assert.throws(() =>
    finding({ ...result, citations: evidence(source, "operations").facts }, e),
  );
});
test("multi-agent synthesis requires every available handoff and names missing agents", () => {
  const e = evidence(source, "engineering"),
    f = finding(
      {
        agent: e.agent,
        taskId: e.agent,
        releaseId: e.releaseId,
        verdict: e.verdict,
        summary: "Tests block release",
        citations: e.facts,
      },
      e,
    ),
    handoffs = [{ resultId: "a".repeat(64), finding: f }],
    s = {
      title: "Readiness",
      summary: "Engineering blocked; operations missing",
      verdict: "incomplete",
      sections: [
        {
          agent: "engineering",
          resultId: handoffs[0]!.resultId,
          summary: f.summary,
        },
      ],
      missingAgents: ["operations"],
    };
  assert.equal(summary(s, handoffs).verdict, "incomplete");
  assert.throws(() => summary({ ...s, verdict: "ready" }, handoffs));
  assert.throws(() => summary({ ...s, missingAgents: [] }, handoffs));
  assert.throws(() =>
    summary(
      { ...s, sections: [{ ...s.sections[0], resultId: "b".repeat(64) }] },
      handoffs,
    ),
  );
});
