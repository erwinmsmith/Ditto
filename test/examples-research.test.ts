import assert from "node:assert/strict";
import test from "node:test";
import {
  request,
  plan,
  assessment,
} from "../examples/_shared/tools/research/domain.ts";
import {
  pageEvidence,
  type Page,
} from "../examples/_shared/tools/web-search/domain.ts";
import { defaultRequest } from "../examples/patterns/deep-research/fixtures.ts";
import { researchFixture } from "../scripts/fixtures/research-http.ts";
import { searchProvider } from "../examples/_shared/tools/web-search/providers.ts";
import { download } from "../examples/_shared/tools/web-search/http.ts";
const p = plan({
  goal: "Research capacity",
  subquestions: [
    { id: "capacity", question: "How many?", query: "Pavo capacity" },
  ],
  clarification: null,
});
const page: Page = {
  requestedUrl: "https://example.com/a",
  url: "https://example.com/a",
  title: "A",
  fetchedAt: new Date().toISOString(),
  snapshot: "hash",
  textHash: "text",
  blocks: ["Pavo supports 25 members."],
};
const pool = pageEvidence(page, ["Pavo"]);
const coverage = {
  selection: { selectedIds: [pool[0]!.id], missing: [], conflicts: [] },
  coverage: [
    {
      id: "capacity",
      status: "covered",
      evidenceIds: [pool[0]!.id],
      gap: null,
      nextQuery: null,
    },
  ],
};
test("research rejects unbounded budgets and duplicate or missing subquestions", () => {
  assert.throws(() => request(defaultRequest({ maxRounds: 50 })), /maxRounds/);
  assert.throws(
    () => request(defaultRequest({ maxModelCalls: 2 })),
    /maxModelCalls/,
  );
  assert.throws(
    () => plan({ ...p, subquestions: [...p.subquestions, ...p.subquestions] }),
    /plan/,
  );
  assert.throws(
    () => assessment({ ...coverage, coverage: [] }, p, pool, false),
    /coverage/,
  );
});
test("coverage must cite selected evidence and cannot hide uncorroborated questions", () => {
  assert.throws(
    () =>
      assessment(
        {
          ...coverage,
          coverage: [{ ...coverage.coverage[0], evidenceIds: ["invented"] }],
        },
        p,
        pool,
        false,
      ),
    /unselected/,
  );
  const result = assessment(coverage, p, pool, true);
  assert.equal(result.coverage[0]!.status, "gap");
  assert.ok(result.selection.missing.some((x) => /corroboration/.test(x)));
  assert.throws(
    () =>
      assessment(
        {
          ...coverage,
          coverage: [
            {
              ...coverage.coverage[0],
              status: "conflict",
              gap: "different values",
            },
          ],
        },
        p,
        pool,
        false,
      ),
    /both sides/,
  );
});
test("research corpus requires a discovered follow-up query before serving the missing fact", async () => {
  const fixture = await researchFixture();
  try {
    const provider = searchProvider(
      { engine: "mediawiki", endpoint: fixture.endpoint },
      { allowLoopbackTest: true },
    );
    const initial = await provider.search({
      query: "Pavo Standard audit retention",
      limit: 6,
    });
    assert.ok(initial.length);
    const overview = await download(initial[0]!.url, fixture.origins, "html", {
      allowLoopbackTest: true,
    });
    assert.match(overview.body, /Meridian Annex/);
    assert.doesNotMatch(overview.body, /30 days/);
    const next = await provider.search({
      query: "Meridian Annex Pavo Standard",
      limit: 6,
    });
    const detail = await download(next[0]!.url, fixture.origins, "html", {
      allowLoopbackTest: true,
    });
    assert.match(detail.body, /30 days/);
  } finally {
    await fixture.close();
  }
});
