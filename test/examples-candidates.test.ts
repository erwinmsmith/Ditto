import assert from "node:assert/strict";
import test from "node:test";
import {
  candidate,
  candidateId,
  assessment,
  eligible,
  check,
  score,
  fusion,
  combine,
  normalized,
  type Catalog,
  type Request,
} from "../examples/_shared/tools/candidates/domain.ts";
const source: Catalog = {
  product: "Orbit",
  cta: "了解产品",
  facts: [
    { id: "offline", text: "支持离线编辑" },
    { id: "export", text: "可导出 Markdown" },
  ],
};
const first = candidate({
  headline: "整理你的工作资料",
  body: "支持离线编辑，可导出 Markdown。",
  cta: source.cta,
  factIds: ["offline", "export"],
});
const second = candidate({
  ...first,
  headline: "从记录到导出",
  body: "从记录开始：支持离线编辑；可导出 Markdown。",
});
const r: Request = {
  id: "task",
  tenant: "demo",
  principal: "editor",
  goal: "Create copy",
  sourceDigest: "a".repeat(64),
  mode: "select",
  allowFallback: true,
  count: 2,
  minScore: 18,
  maxModelCalls: 8,
  deadlineSeconds: 600,
};
test("candidate hard checks reject invented facts, altered calls to action and invalid lengths", () => {
  assert.deepEqual(check(first, source), []);
  assert.ok(
    check({ ...first, factIds: ["offline", "invented"] }, source).length,
  );
  assert.ok(check({ ...first, body: "Just a description" }, source).length);
  assert.ok(check({ ...first, cta: "Pay now" }, source).length);
  assert.ok(check({ ...first, headline: "界".repeat(41) }, source).length);
  assert.equal(
    normalized({ ...first, headline: "整理 你的工作资料！" }),
    normalized(first),
  );
});
test("scoring binds to candidate identity and cannot waive hard failures", () => {
  const id = candidateId(first),
    a = assessment(
      {
        candidateId: id,
        verdict: "pass",
        scores: { clarity: 4, fit: 4, credibility: 4 },
        rationale: "Clear grounded copy",
        issues: [],
      },
      id,
    );
  assert.equal(score(a), 20);
  assert.ok(
    eligible(
      {
        candidateId: id,
        sourceDigest: r.sourceDigest,
        issues: [],
        assessment: a,
      },
      r,
    ),
  );
  assert.ok(
    !eligible(
      {
        candidateId: id,
        sourceDigest: r.sourceDigest,
        issues: ["unsupported"],
        assessment: a,
      },
      r,
    ),
  );
  assert.throws(() => assessment({ ...a, candidateId: "0".repeat(64) }, id));
  assert.throws(() =>
    assessment({ ...a, scores: { ...a.scores, clarity: 6 } }, id),
  );
  assert.throws(() => assessment({ ...a, issues: ["Invalid"] }, id));
});
test("fusion preserves field lineage and requires a genuinely different combination", () => {
  const a = candidateId(first),
    b = candidateId(second),
    parents = new Map([
      [a, first],
      [b, second],
    ]),
    f = fusion(
      {
        headlineFrom: a,
        bodyFrom: b,
        ctaFrom: a,
        reason: "Join an audience-focused headline with a workflow body.",
      },
      [a, b],
    );
  const merged = combine(f, parents);
  assert.equal(merged.headline, first.headline);
  assert.equal(merged.body, second.body);
  assert.deepEqual(merged.factIds, second.factIds);
  assert.throws(() => fusion({ ...f, bodyFrom: a }, [a, b]));
  assert.throws(() => fusion({ ...f, headlineFrom: "0".repeat(64) }, [a, b]));
  const sameHeadline = { ...second, headline: first.headline };
  assert.throws(() =>
    combine(
      f,
      new Map([
        [a, first],
        [b, sameHeadline],
      ]),
    ),
  );
});
