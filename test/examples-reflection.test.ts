import assert from "node:assert/strict";
import test from "node:test";
import {
  sources,
  check,
  review,
  draft,
  draftId,
} from "../examples/_shared/tools/reflection/domain.ts";
import { flawedDraft } from "../examples/_shared/tools/reflection/adapters.ts";
const csv =
  "month,grossCents,refundCents\n2026-07,120000,6000\n2026-08,150000,9000\n";
test("reflection computes net revenue and rejects unsupported source rows", () => {
  assert.deepEqual(sources(csv).metrics, {
    baselineNetCents: 114000,
    currentNetCents: 141000,
    growthPercent: 23.68,
  });
  assert.equal(
    sources("month,grossCents,refundCents\n2026-07,100,100\n2026-08,200,0\n")
      .metrics,
    null,
  );
  assert.throws(() => sources(csv + "2026-08,150000,9000\n"));
  assert.throws(() => sources(csv.replace("150000,9000", "150000,190000")));
  assert.throws(() => sources(csv.replace("150000", "NaN")));
});
test("review cannot change draft identity or claim pass with outstanding issues", () => {
  const id = draftId(flawedDraft);
  assert.throws(() =>
    review({ draftId: "0".repeat(64), verdict: "pass", issues: [] }, id),
  );
  assert.throws(() =>
    review(
      {
        draftId: id,
        verdict: "pass",
        issues: [{ field: "metrics", message: "Wrong" }],
      },
      id,
    ),
  );
  assert.throws(() =>
    review({ draftId: id, verdict: "revise", issues: [] }, id),
  );
  assert.ok(check(flawedDraft, sources(csv)).length >= 5);
  // Even a structurally valid reviewer pass does not change deterministic findings.
  review({ draftId: id, verdict: "pass", issues: [] }, id);
  assert.ok(check(flawedDraft, sources(csv)).length >= 5);
});
test("draft checks require exact source quotes and complete grounded report structure", () => {
  const s = sources(csv),
    d = draft({
      ...flawedDraft,
      metrics: s.metrics,
      limitations: ["Two periods do not establish causation."],
      actions: [{ owner: "Analyst", task: "Review returns by product." }],
      citations: s.rows.map((r) => ({
        sourceId: r.id,
        quote: `${r.month},${r.grossCents},${r.refundCents}`,
      })),
    });
  assert.deepEqual(check(d, s), []);
  d.citations[0]!.quote = "fabricated";
  assert.ok(check(d, s).some((i) => i.field === "citations"));
  assert.throws(() =>
    draft({ ...d, metrics: { ...d.metrics, growthPercent: NaN } }),
  );
});

test("citations preserve original numeric spelling instead of reconstructing rows", () => {
  const source = sources(csv.replace("120000,6000", "0120000,006000"));
  const report = draft({
    ...flawedDraft,
    metrics: source.metrics,
    limitations: ["Two periods do not establish causation."],
    actions: [{ owner: "Analyst", task: "Collect more periods." }],
    citations: source.rows.map((row) => ({
      sourceId: row.id,
      quote: row.quote,
    })),
  });
  assert.deepEqual(check(report, source), []);
  report.citations[0]!.quote = "2026-07,120000,6000";
  assert.ok(check(report, source).some((issue) => issue.field === "citations"));
});
