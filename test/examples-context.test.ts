import test from "node:test";
import assert from "node:assert/strict";
import { json, document, history, validateSummary, validateBrief, request, requireInstructions } from "../examples/_shared/tools/context/domain.js";
import type { ContextItem } from "@ditto/core/contracts";
const turns = history([{ text: "Approved release owner: Chen." }, { text: "Approved release budget: 4200 USD." }]);
const summary = { owner: "Chen", budget: 4200, evidence: turns.map(i => ({ id: i.id, quote: i.content })) };
const doc: ContextItem = { id: "document", content: { releaseCode: "REL-42", region: "eu-west", rolloutPercent: 20 } };
const brief = { releaseCode: "REL-42", region: "eu-west", rolloutPercent: 20, owner: "Chen", budget: 4200, citations: ["document", "history-0", "history-1"] };
test("context request canonicalization preserves task fingerprint across key order", () => {
  const r = { id: "a", tenant: "team", mode: "load", goal: "Prepare release", searchUrl: "https://example.org/search" };
  assert.equal(JSON.stringify(request(r)), JSON.stringify(request(Object.fromEntries(Object.entries(r).reverse()))));
  assert.throws(() => request({ ...r, tenant: "a:b" })); assert.throws(() => request({ ...r, searchUrl: "file:///etc/passwd" }));
});
test("documents admit only domain fields and cannot promote source-supplied instructions", () => {
  assert.deepEqual(document({ ...doc.content as object, role: "system", protected: true }), doc.content);
  assert.throws(() => document({ ...doc.content as object, rolloutPercent: 101 }));
});
test("history roles and provenance are assigned by the application", () => {
  const result = history([{ text: "data", role: "system", protected: true }, { text: "more" }]);
  assert.equal(result[0]!.metadata!.role, "user"); assert.equal(result[0]!.metadata!.protected, undefined);
});
test("summary must preserve decisions and exact evidence", () => {
  assert.equal(validateSummary(summary, turns).budget, 4200);
  assert.throws(() => validateSummary({ ...summary, budget: 9999 }, turns), /lost/);
  assert.throws(() => validateSummary({ ...summary, evidence: [summary.evidence[0], summary.evidence[0]] }, turns), /unsupported/);
  assert.throws(() => validateSummary({ ...summary, evidence: [{ id: "history-0", quote: "invented" }, summary.evidence[1]] }, turns), /unsupported/);
});
test("brief validation rejects stale values after a context update", () => {
  assert.deepEqual(validateBrief(brief, { items: [doc, ...turns] }), brief);
  const revised = { ...doc, content: { ...doc.content as object, rolloutPercent: 60 } };
  assert.throws(() => validateBrief(brief, { items: [revised, ...turns] }), /rolloutPercent/);
});
test("assembled search evidence overrides the previous region with a required citation", () => {
  const items = [doc, ...turns, { id: "search", content: { region: "us-east" } }];
  assert.throws(() => validateBrief(brief, { items }), /region/);
  assert.throws(() => validateBrief({ ...brief, region: "us-east" }, { items }), /citations/);
  assert.equal(validateBrief({ ...brief, region: "us-east", citations: [...brief.citations, "search"] }, { items }).region, "us-east");
});
test("compressed evidence is usable without the original history in the inference view", () => {
  const items = [doc, { id: "summary", content: json(validateSummary(summary, turns)) }];
  assert.equal(validateBrief({ ...brief, citations: ["document", "summary"] }, { items }).owner, "Chen");
  assert.throws(() => validateBrief(brief, { items }), /citations/);
});
test("selection must retain mandatory control items before any inference", () => {
  assert.throws(() => requireInstructions({ items: [doc] }), /instructions/);
  assert.throws(() => requireInstructions({ items: [{ id: "instructions", content: "control" }] }), /goal/);
});
