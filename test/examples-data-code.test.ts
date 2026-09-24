import test from "node:test";
import assert from "node:assert/strict";
import {
  request,
  material,
  plan,
  clean,
  metrics,
  profile,
  interpretation,
  pointer,
  evidenceCatalog,
  testSummary,
  digest,
  type Request,
  type Material,
  type Outcome,
  type Interpretation,
} from "../examples/_shared/tools/data-and-code/domain.js";
const raw = {
  orderId: "  a ",
  date: "2026/09/01",
  region: " east ",
  quantity: "2",
  unitCents: "300",
  status: " PAID ",
};
test("cleaning preserves valid zero values and rejects missing, negative and invalid calendar values", () => {
  const rows = [
    raw,
    { ...raw, orderId: "b", quantity: "0", region: "" },
    { ...raw, orderId: "c", quantity: "" },
    { ...raw, orderId: "d", unitCents: "-1" },
    { ...raw, orderId: "e", date: "2026-02-30" },
    raw,
  ];
  const result = clean(rows);
  assert.deepEqual(result.rows, [
    {
      orderId: "a",
      date: "2026-09-01",
      region: "East",
      quantity: 2,
      unitCents: 300,
      status: "paid",
    },
    {
      orderId: "b",
      date: "2026-09-01",
      region: "Unknown",
      quantity: 0,
      unitCents: 300,
      status: "paid",
    },
  ]);
  assert.deepEqual(
    result.issues.map((i) => i.reason),
    ["invalid-number", "invalid-number", "invalid-date", "duplicate-order-id"],
  );
});
test("duplicate removal keeps the first valid row, not a preceding rejected row", () =>
  assert.equal(clean([{ ...raw, quantity: "" }, raw]).rows[0]!.quantity, 2));
test("paid metrics exclude other statuses and zero observations do not imply correlation", () => {
  const rows = clean([raw, { ...raw, orderId: "b", status: "refunded" }]).rows;
  assert.deepEqual(metrics(rows), {
    paidOrders: 1,
    totalRevenueCents: 600,
    averageOrderCents: 600,
    byRegion: [{ region: "East", revenueCents: 600, orders: 1 }],
  });
  assert.equal(profile([raw], rows).pearsonQuantityLineValue, null);
  assert.equal(metrics([]).averageOrderCents, 0);
});
const text = "export function invoiceTotal(items) { return 0; }\n";
const r: Request = {
  id: "task-a",
  tenant: "team-a",
  mode: "code-modification",
  instruction: "Fix invoice",
  sources: [
    { path: "invoice.mjs", sha256: digest(text) },
    { path: "invoice.test.mjs", sha256: digest("tests") },
    { path: "README.md", sha256: digest("spec") },
  ],
};
const m: Material = {
  files: [
    { ...r.sources[0]!, content: text },
    { ...r.sources[1]!, content: "tests" },
    { ...r.sources[2]!, content: "spec" },
  ],
};
test("code request pins its source inventory and content", () => {
  assert.deepEqual(request(r), r);
  assert.deepEqual(material(m, r), m);
  assert.throws(
    () =>
      request({ ...r, sources: [r.sources[0]!, r.sources[0]!, r.sources[2]!] }),
    /inventory/,
  );
  const changed = structuredClone(m);
  changed.files[0]!.content = "different";
  assert.throws(() => material(changed, r), /checksum/);
});
test("plans reject another tool, changed source version and edits to protected tests", () => {
  const p = {
    tool: "code_patch",
    arguments: {
      path: "invoice.mjs",
      expectedSha256: r.sources[0]!.sha256,
      content: text,
    },
  };
  assert.deepEqual(plan(p, r, m), p);
  assert.throws(() => plan({ ...p, tool: "data_query" }, r, m), /not allowed/);
  for (const change of [
    { path: "invoice.test.mjs" },
    { expectedSha256: "changed" },
  ])
    assert.throws(
      () => plan({ ...p, arguments: { ...p.arguments, ...change } }, r, m),
      /Patch target/,
    );
});
test("JSON pointer evidence resolves escaped keys and rejects inherited properties", () => {
  assert.equal(pointer({ "a/b": { "~x": 5 } }, "/a~1b/~0x"), 5);
  assert.throws(() => pointer({}, "/constructor"), /Unknown/);
});
const o: Outcome = {
  tool: "code_patch",
  result: { after: { exitCode: 0 } },
  evidence: {},
  files: [],
};
const a: Interpretation = {
  summary: "Protected tests passed",
  insights: [
    {
      text: "Exit code is zero",
      evidence: [{ pointer: "/after/exitCode", value: 0 }],
    },
  ],
  issues: [],
  limitations: ["A bounded suite does not prove all behavior"],
};
test("interpretation cannot cite invented execution values", () => {
  assert.deepEqual(interpretation(a, r, m, o), a);
  const changed = structuredClone(a);
  changed.insights[0]!.evidence[0]!.value = 1;
  assert.throws(() => interpretation(changed, r, m, o), /evidence/);
});
test("code review anchors exact quotes at real source lines", () => {
  const rr = { ...r, mode: "code-review" as const },
    review = {
      ...a,
      issues: [
        {
          path: "invoice.mjs",
          line: 1,
          quote: text.trim(),
          severity: "high" as const,
          reason: "Always returns zero",
          fix: "Sum quantity times price",
        },
      ],
    };
  assert.deepEqual(interpretation(review, rr, m, o), review);
  assert.throws(
    () =>
      interpretation(
        { ...review, issues: [{ ...review.issues[0]!, line: 2 }] },
        rr,
        m,
        o,
      ),
    /location/,
  );
});

test("test summaries preserve actual TAP counts and failed case names", () => {
  assert.deepEqual(
    testSummary(
      "ok 1 - empty\nnot ok 2 - totals\n# tests 2\n# pass 1\n# fail 1\n",
    ),
    {
      tests: 2,
      passed: 1,
      failed: 1,
      cases: [
        { name: "empty", passed: true },
        { name: "totals", passed: false },
      ],
    },
  );
});
test("evidence catalog excludes oversized logs while retaining scalar results", () => {
  assert.deepEqual(
    evidenceCatalog({
      log: "x".repeat(201),
      rows: [{ count: 2 }],
      empty: null,
    }),
    [
      { pointer: "/rows/0/count", value: 2 },
      { pointer: "/empty", value: null },
    ],
  );
});
