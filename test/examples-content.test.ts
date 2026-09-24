import test from "node:test";
import assert from "node:assert/strict";
import {
  source,
  validateDraft,
  assembleDraft,
  validateMaterial,
  validateReview,
  request,
  type Request,
  type Material,
  type Draft,
  type Review,
} from "../examples/_shared/tools/content/domain.js";
import {
  render,
  htmlEscape,
} from "../examples/_shared/tools/content/render.js";
const paragraphs = [
  "NimbusDesk ND-42 是杭州试点服务。",
  "开放日期为 2026-10-15。",
  "每天最多提交 30 个任务。",
  "必须人工审批；不提供自动数据导出。",
];
const m: Material = {
  sources: [
    source("brief", "brief.md", "# 资料\n" + paragraphs.join("\n") + "\n"),
    source("notes", "notes.md", "# 纪要\n提交租户编号申请。\n"),
    source("draft", "draft.md", "# 通知\n" + paragraphs.join("\n") + "\n"),
  ],
};
const r: Request = {
  id: "content-a",
  tenant: "team-a",
  mode: "convert",
  anchors: ["ND-42", "2026-10-15", "30"],
  sources: m.sources.map((s) => ({ id: s.id, file: s.file, sha256: s.sha256 })),
};
const d: Draft = {
  title: "通知",
  language: "zh-CN",
  sections: m.sources[2]!.blocks.map((b) => ({
    heading: "说明",
    text: b.text,
    citations: [{ blockId: b.id, quote: b.text }],
  })),
};
const review: Review = {
  approved: true,
  checks: {
    fidelity: true,
    coverage: true,
    transformation: true,
    citations: true,
  },
  issues: [],
};
test("conversion preserves source paragraphs and order", () => {
  assert.deepEqual(validateDraft(d, r, m), d);
  const bad = structuredClone(d);
  bad.sections.reverse();
  assert.throws(() => validateDraft(bad, r, m), /changed source/);
});
test("citations require real block IDs and exact original quotes", () => {
  for (const field of ["quote", "blockId"] as const) {
    const bad = structuredClone(d);
    bad.sections[0]!.citations[0]![field] = "invented";
    assert.throws(() => validateDraft(bad, r, m), /Unsupported citation/);
  }
});
test("source content is pinned by its digest and line locations", () => {
  assert.deepEqual(validateMaterial(m, r), m);
  const bad = structuredClone(m);
  bad.sources[0]!.blocks[0]!.line = 99;
  assert.throws(() => validateMaterial(bad, r), /snapshot mismatch/);
  bad.sources[0]!.content += "changed";
  assert.throws(() => validateMaterial(bad, r), /snapshot mismatch/);
});
test("protected facts and ungrounded numbers block publication", () => {
  const bad = structuredClone(d);
  bad.sections[0]!.text = "NimbusDesk 其他产品";
  assert.throws(() => validateDraft(bad, r, m), /Missing protected/);
  const extra = structuredClone(d);
  extra.sections[0]!.text += " 999999 个任务";
  assert.throws(() => validateDraft(extra, r, m), /numerical claim/);
});
test("mandatory evidence coverage cannot be silently omitted", () => {
  const bad = structuredClone(d);
  bad.sections[3]!.citations = bad.sections[0]!.citations;
  assert.throws(() => validateDraft(bad, r, m), /coverage missing/);
});
test("translation requires target-language text and protected terminology", () => {
  const bad = { ...d, language: "en" as const };
  assert.throws(
    () => validateDraft(bad, { ...r, mode: "translate" }, m),
    /language mismatch/,
  );
});
test("review must affirm every check with no unresolved issues", () => {
  assert.deepEqual(validateReview(review), review);
  assert.throws(
    () => validateReview({ ...review, approved: false }),
    /rejected/,
  );
  assert.throws(
    () =>
      validateReview({
        ...review,
        checks: { ...review.checks, fidelity: false },
      }),
    /rejected/,
  );
  assert.throws(
    () => validateReview({ ...review, issues: ["unsupported fact"] }),
    /rejected/,
  );
});
test("HTML escapes generated text and emits no executable markup", () => {
  const text = '<script>alert("x")</script> & <img src=x onerror=x>';
  const bad = structuredClone(d);
  bad.sections[0]!.text = text;
  const files = render(bad, m, review);
  assert.ok(files["content.html"]!.includes(htmlEscape(text)));
  assert.ok(!files["content.html"]!.includes("<script>"));
});
test("all renderings share original reference paths, lines and content hashes", () => {
  const files = render(d, m, review),
    doc = JSON.parse(files["content.json"]!);
  assert.deepEqual(doc.sections, d.sections);
  for (const ref of doc.references) {
    assert.equal(files[ref.file]!.split("\n")[ref.line - 1], ref.quote);
    assert.ok(files["content.md"]!.includes(`${ref.file}#L${ref.line}`));
    assert.ok(files["content.html"]!.includes(`id="${ref.id}"`));
  }
  assert.ok(
    JSON.parse(files["manifest.json"]!).files.some(
      (f: { file: string }) => f.file === "review.json",
    ),
  );
});
test("controller source paths and request identity are validated", () => {
  assert.deepEqual(request({ ...r, extra: true }), r);
  assert.throws(
    () =>
      request({
        ...r,
        sources: [
          { ...r.sources[0], file: "../private" },
          ...r.sources.slice(1),
        ],
      }),
    /descriptor/,
  );
});

test("expansion retains the original lead through controller assembly", () => {
  const value = assembleDraft(
    {
      title: "扩展",
      language: "zh-CN",
      sections: [{ heading: "补充", text: "新增内容", citations: [] }],
    },
    { ...r, mode: "expand" },
    m,
  ) as Draft;
  assert.equal(value.sections[0]!.text, m.sources[2]!.blocks[0]!.text);
  assert.ok(value.sections[0]!.citations.some((c) => c.blockId === "brief:2"));
  assert.equal(value.sections[1]!.text, "新增内容");
});
