import test from "node:test";
import assert from "node:assert/strict";
import {
  request,
  material,
  analysis,
  type Request,
  type Material,
  type Analysis,
} from "../examples/_shared/tools/multimodal/domain.js";
const r: Request = {
  id: "media-a",
  tenant: "team-a",
  mode: "document-parsing",
  instruction: "Understand this document",
  sources: [
    {
      id: "brief",
      path: "brief.pdf",
      mediaType: "application/pdf",
      sha256: "a".repeat(64),
    },
  ],
};
const m: Material = {
  sources: [
    {
      ...r.sources[0]!,
      engine: "Poppler",
      blocks: [{ location: "page:1", text: "Quota: 40 teams" }],
      images: [],
      details: {},
    },
  ],
};
const a: Analysis = {
  summary: "Quota is 40 teams",
  findings: [
    {
      statement: "40 teams",
      sourceId: "brief",
      location: "page:1",
      quote: "Quota: 40 teams",
    },
  ],
  data: { subject: "Quota", keyPoints: ["40 teams"] },
  limitations: [],
};
test("media request binds unique sources, mode and hashes", () => {
  assert.deepEqual(request(r), r);
  assert.throws(
    () => request({ ...r, sources: [...r.sources, ...r.sources] }),
    /identity/,
  );
  assert.throws(
    () => request({ ...r, mode: "video-understanding" }),
    /Media type/,
  );
  assert.throws(
    () => request({ ...r, mode: "document-comparison" }),
    /multiple documents/,
  );
});
test("media material rejects substituted sources and duplicate evidence locations", () => {
  assert.deepEqual(material(m, r), m);
  const changed = structuredClone(m);
  changed.sources[0]!.sha256 = "b".repeat(64);
  assert.throws(() => material(changed, r), /identity/);
  const duplicate = structuredClone(m);
  duplicate.sources[0]!.blocks.push({ ...duplicate.sources[0]!.blocks[0]! });
  assert.throws(() => material(duplicate, r), /Duplicate/);
});
test("text evidence requires both original location and exact quote", () => {
  assert.deepEqual(analysis(a, r, m), a);
  for (const field of ["sourceId", "location", "quote"] as const) {
    const changed = structuredClone(a);
    changed.findings[0]![field] = "fabricated";
    assert.throws(() => analysis(changed, r, m), /evidence|Evidence/);
  }
});
const imageRequest: Request = {
  ...r,
  mode: "chart-understanding",
  sources: [{ ...r.sources[0]!, path: "chart.png", mediaType: "image/png" }],
};
const imageMaterial: Material = {
  sources: [
    {
      ...imageRequest.sources[0]!,
      engine: "Pillow",
      blocks: [],
      images: [
        {
          location: "image:1",
          path: "snapshots/0.jpg",
          sha256: "b".repeat(64),
          mediaType: "image/jpeg",
        },
      ],
      details: {},
    },
  ],
};
const chart: Analysis = {
  summary: "Ticket count rose",
  findings: [
    {
      statement: "A has 20; B has 40",
      sourceId: "brief",
      location: "image:1",
      quote: "",
    },
  ],
  data: {
    series: [
      { label: "A", value: 20 },
      { label: "B", value: 40 },
    ],
    maximum: "B",
    change: 20,
  },
  limitations: [],
};
test("visual observations cannot masquerade as verified text quotations", () => {
  assert.deepEqual(analysis(chart, imageRequest, imageMaterial), chart);
  const changed = structuredClone(chart);
  changed.findings[0]!.quote = "20";
  assert.throws(
    () => analysis(changed, imageRequest, imageMaterial),
    /quotation/,
  );
});
test("chart maximum and change must agree with extracted series", () => {
  for (const change of [
    { maximum: "A" },
    { change: 40 },
    {
      series: [
        { label: "A", value: "20" },
        { label: "B", value: 40 },
      ],
    },
  ])
    assert.throws(
      () =>
        analysis(
          { ...chart, data: { ...chart.data, ...change } },
          imageRequest,
          imageMaterial,
        ),
      /chart|Chart/,
    );
});
test("video evidence covers all frames and declares sampling limitations", () => {
  const vr = { ...r, mode: "video-understanding" as const },
    vm = structuredClone(imageMaterial);
  vm.sources[0]!.images = [0.6, 3, 5.4].map((n) => ({
    ...imageMaterial.sources[0]!.images[0]!,
    location: "seconds:" + n,
  }));
  const va: Analysis = {
    summary: "Circle moves right",
    findings: vm.sources[0]!.images.map((i) => ({
      statement: "Circle",
      sourceId: "brief",
      location: i.location,
      quote: "",
    })),
    data: {
      direction: "right",
      events: [{ location: "seconds:3", description: "Circle at center" }],
    },
    limitations: ["Three sampled frames; no audio"],
  };
  assert.deepEqual(analysis(va, vr, vm), va);
  assert.throws(
    () => analysis({ ...va, findings: va.findings.slice(1) }, vr, vm),
    /Every sampled frame/,
  );
  assert.throws(() => analysis({ ...va, limitations: [] }, vr, vm), /Sampling/);
});
