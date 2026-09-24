import assert from "node:assert/strict";
import test from "node:test";
import {
  download,
  publicAddress,
  permitted,
  retryDelay,
} from "../examples/_shared/tools/web-search/http.ts";
import {
  request,
  candidates,
  pageEvidence,
  verification,
  type Page,
} from "../examples/_shared/tools/web-search/domain.ts";
import { defaultRequest } from "../examples/patterns/web-search-qa/fixtures.ts";
import { webFixture } from "../scripts/fixtures/web-search-http.ts";
test("web policy rejects credential URLs, off-origin references and invalid budgets", () => {
  assert.throws(
    () =>
      request(
        defaultRequest({ referenceUrls: ["https://evil.example/private"] }),
      ),
    /denied/,
  );
  assert.throws(() => request(defaultRequest({ maxPages: 100 })), /budget/);
  assert.throws(() =>
    permitted("https://user:secret@public.example/", [
      "https://public.example",
    ]),
  );
  assert.throws(() =>
    permitted("http://127.0.0.1:8000/", ["http://127.0.0.1:8000"]),
  );
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
  assert.equal(retryDelay("1"), 1000);
  assert.throws(() => retryDelay("3600"), /BUDGET/);
});
test("discovery deduplicates fragments and never executes off-policy search URLs", () => {
  const r = defaultRequest({ referenceUrls: [], maxPages: 1 });
  assert.deepEqual(
    candidates(
      [
        {
          url: "https://www.sqlite.org/a#x",
          title: "A",
          snippet: "not evidence",
        },
        { url: "https://www.sqlite.org/a#y", title: "A", snippet: "" },
        { url: "http://127.0.0.1/", title: "secret", snippet: "" },
        { url: "https://www.sqlite.org/b", title: "B", snippet: "" },
      ],
      r,
    ),
    {
      urls: ["https://www.sqlite.org/a"],
      omittedUrls: ["https://www.sqlite.org/b"],
    },
  );
});
test("two URLs on one origin or copied text do not count as corroboration", () => {
  const p: Page = {
    requestedUrl: "https://source.example/a",
    url: "https://source.example/a",
    title: "Source",
    fetchedAt: new Date().toISOString(),
    snapshot: "a",
    textHash: "b",
    blocks: ["The plan allows 25 members."],
  };
  const a = pageEvidence(p, ["members"])[0]!,
    b = { ...a, id: "other", uri: "https://other.example/a" };
  const draft = {
    status: "answered" as const,
    claims: [
      {
        text: "25 members",
        citations: [
          { chunkId: a.id, quote: a.text },
          { chunkId: b.id, quote: b.text },
        ],
      },
    ],
    limitations: [],
  };
  assert.equal(
    verification(draft, [a, b], {
      selectedIds: [a.id, b.id],
      missing: [],
      conflicts: [],
    })[0]!.status,
    "single-source",
  );
});
test("real HTTP adapter retries 429, rejects redirect escapes and obeys cancellation", async () => {
  const fixture = await webFixture();
  try {
    fixture.set({ fault: "page-throttle" });
    const url = fixture.origins[0] + "/wiki/Pavo_primary";
    const page = await download(url, fixture.origins, "html", {
      allowLoopbackTest: true,
    });
    assert.ok(page.body.includes("25 members"));
    assert.deepEqual(
      fixture.requests.map((r) => r.status),
      [429, 200],
    );
    fixture.set({ fault: "redirect-denied" });
    await assert.rejects(
      download(url, fixture.origins, "html", { allowLoopbackTest: true }),
      /POLICY_DENIED/,
    );
    await assert.rejects(
      download(
        url,
        fixture.origins,
        "html",
        { allowLoopbackTest: true },
        AbortSignal.abort(),
      ),
    );
    fixture.set({ fault: "hanging-page" });
    await assert.rejects(
      download(
        url,
        fixture.origins,
        "html",
        { allowLoopbackTest: true },
        AbortSignal.timeout(30),
      ),
      /abort/i,
    );
  } finally {
    await fixture.close();
  }
});
