import { common, object, check, message, steps, list, text, number } from "../../validation.js";
import type { DeliberateInput, DeliberateOutput } from "./types.js";
export function validateDeliberate(input: unknown): asserts input is DeliberateInput {
  const v = common(input);
  if (v.messages !== undefined) { list(v.messages, "messages"); v.messages.forEach(message); }
  list(v.candidates, "candidates"); check(v.candidates.length > 0, "candidates must not be empty");
  const ids = new Set<string>();
  for (const raw of v.candidates) { const c = object(raw); text(c.id, "candidate.id"); check(!ids.has(c.id), "Duplicate candidate ID"); ids.add(c.id); message(c.result); if (c.trajectory !== undefined) steps(c.trajectory); if (c.score !== undefined) number(c.score, "candidate.score"); }
  check(["select", "merge", "consensus", "debate"].includes(String(v.mode)), "Invalid deliberation mode");
  if (v.selectCount !== undefined) { check(v.mode === "select", "selectCount requires select mode"); number(v.selectCount, "selectCount", 1, v.candidates.length, true); }
  if (v.objective !== undefined) text(v.objective, "objective", true);
}
export function validateDeliberateOutput(v: Record<string, unknown>, input: DeliberateInput): asserts v is Record<string, unknown> & DeliberateOutput {
  message(v.result); const ids = new Set(input.candidates.map(c => c.id));
  if (v.selectedCandidateIds !== undefined) {
    list(v.selectedCandidateIds, "selectedCandidateIds");
    check(new Set(v.selectedCandidateIds).size === v.selectedCandidateIds.length, "Duplicate selected ID");
    for (const id of v.selectedCandidateIds) check(typeof id === "string" && ids.has(id), "Unknown selected candidate");
  }
  if (input.mode === "select") check(Array.isArray(v.selectedCandidateIds) && v.selectedCandidateIds.length === (input.selectCount ?? 1), "select requires exactly selectCount candidate IDs");
  if (v.assessments !== undefined) {
    list(v.assessments, "assessments"); const seen = new Set<string>();
    for (const raw of v.assessments) { const a = object(raw); text(a.candidateId, "candidateId"); check(ids.has(a.candidateId) && !seen.has(a.candidateId), "Unknown or duplicate assessed candidate"); seen.add(a.candidateId); if (a.score !== undefined) number(a.score, "score"); if (a.accepted !== undefined) check(typeof a.accepted === "boolean", "accepted must be boolean"); if (a.summary !== undefined) text(a.summary, "summary", true); }
  }
  if (v.decisionSummary !== undefined) text(v.decisionSummary, "decisionSummary", true);
}
