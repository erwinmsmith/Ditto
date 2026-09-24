import {
  request as webRequest,
  verification,
  type Request as WebRequest,
  type Evidence,
  type Failure,
} from "../web-search/domain.ts";
import {
  object,
  text,
  strings,
  identifier,
  selection,
  answer,
  type Selection,
  type Answer,
} from "../evidence.ts";
export interface Request extends WebRequest {
  researchType: "market" | "industry" | "academic" | "competitive" | "policy";
  audience: string;
  scope: string;
  maxRounds: number;
  maxSearches: number;
  maxReadPages: number;
  maxModelCalls: number;
  researchSeconds: number;
}
export function request(v: unknown): Request {
  const raw = object(v),
    base = webRequest(v);
  if (
    !["market", "industry", "academic", "competitive", "policy"].includes(
      String(raw.researchType),
    )
  )
    throw new Error("Invalid research type");
  const integer = (key: string, min: number, max: number) => {
    const n = raw[key];
    if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max)
      throw new Error(`Invalid ${key}`);
    return Number(n);
  };
  return {
    ...base,
    researchType: raw.researchType as Request["researchType"],
    audience: text(raw.audience, 300),
    scope: text(raw.scope, 1000),
    maxRounds: integer("maxRounds", 1, 4),
    maxSearches: integer("maxSearches", 1, 12),
    maxReadPages: integer("maxReadPages", 1, 16),
    maxModelCalls: integer("maxModelCalls", 8, 24),
    researchSeconds: integer("researchSeconds", 1, 3600),
  };
}
export const webInput = (r: Request) => webRequest(r);
export interface Plan {
  goal: string;
  subquestions: { id: string; question: string; query: string }[];
  clarification: string | null;
}
export function plan(v: unknown): Plan {
  const p = object(v);
  if (!Array.isArray(p.subquestions) || p.subquestions.length > 3)
    throw new Error("Invalid subquestions");
  const subquestions = p.subquestions.map((v) => {
    const q = object(v);
    return {
      id: identifier(q.id),
      question: text(q.question, 400),
      query: text(q.query, 100),
    };
  });
  if (
    new Set(subquestions.map((q) => q.id)).size !== subquestions.length ||
    (p.clarification === null && !subquestions.length)
  )
    throw new Error("Invalid research plan");
  return {
    goal: text(p.goal, 600),
    subquestions,
    clarification: p.clarification === null ? null : text(p.clarification, 500),
  };
}
export interface Coverage {
  id: string;
  status: "covered" | "gap" | "conflict";
  evidenceIds: string[];
  gap: string | null;
  nextQuery: string | null;
}
export interface Assessment {
  selection: Selection;
  coverage: Coverage[];
}
export function assessment(
  v: unknown,
  p: Plan,
  pool: Evidence[],
  crossCheck: boolean,
): Assessment {
  const raw = object(v),
    selected = selection(raw.selection, pool);
  if (
    !Array.isArray(raw.coverage) ||
    raw.coverage.length !== p.subquestions.length
  )
    throw new Error("Missing subquestion coverage");
  const seen = new Set<string>();
  const coverage = raw.coverage.map((v) => {
    const c = object(v),
      id = identifier(c.id);
    if (
      !p.subquestions.some((q) => q.id === id) ||
      seen.has(id) ||
      !["covered", "gap", "conflict"].includes(String(c.status))
    )
      throw new Error("Invalid coverage");
    seen.add(id);
    const evidenceIds = strings(c.evidenceIds, 8);
    if (evidenceIds.some((id) => !selected.selectedIds.includes(id)))
      throw new Error("Coverage cites unselected evidence");
    const item: Coverage = {
      id,
      status: c.status as Coverage["status"],
      evidenceIds,
      gap: c.gap === null ? null : text(c.gap, 500),
      nextQuery: c.nextQuery === null ? null : text(c.nextQuery, 100),
    };
    if (item.status === "covered" && (!evidenceIds.length || item.gap !== null))
      throw new Error("Covered question needs evidence and no gap");
    if (
      item.status === "conflict" &&
      !selected.conflicts.some((x) =>
        x.sourceIds.every((id) => evidenceIds.includes(id)),
      )
    )
      throw new Error("Conflict requires both sides");
    if (item.status !== "covered" && !item.gap)
      throw new Error("Explain coverage gap");
    if (
      crossCheck &&
      item.status === "covered" &&
      new Set(
        pool
          .filter((e) => evidenceIds.includes(e.id))
          .map((e) => new URL(e.uri).origin),
      ).size < 2
    ) {
      item.status = "gap";
      item.gap = "Independent origin corroboration is missing.";
    }
    return item;
  });
  // The coverage matrix is authoritative: a missing subquestion cannot disappear in synthesis.
  selected.missing = [
    ...new Set([
      ...selected.missing,
      ...coverage.filter((c) => c.status === "gap").map((c) => c.gap!),
    ]),
  ].slice(0, 5);
  return { selection: selected, coverage };
}
export interface Usage {
  modelCalls: number;
  searches: number;
  pages: number;
  startedAt: string;
}
export interface Round {
  number: number;
  queries: string[];
  newEvidence: number;
  assessment: Assessment;
}
export type StopReason =
  | "coverage-complete"
  | "round-budget"
  | "search-budget"
  | "page-budget"
  | "model-budget"
  | "deadline"
  | "no-progress"
  | "clarification";
export interface Report {
  requestId: string;
  question: string;
  researchType: Request["researchType"];
  scope: string;
  audience: string;
  plan: Plan;
  rounds: Round[];
  assessment: Assessment;
  evidence: Evidence[];
  answer: Answer;
  verification: ReturnType<typeof verification>;
  failures: Failure[];
  omittedUrls: string[];
  stopReason: StopReason;
  usage: Usage;
  generatedAt: string;
  grounding: "model-checked" | "no-claims";
}
export function validateReport(v: unknown, r: Request): Report {
  const report = v as Report;
  if (
    !report ||
    report.requestId !== r.id ||
    report.question !== r.question ||
    report.scope !== r.scope ||
    report.audience !== r.audience ||
    report.researchType !== r.researchType ||
    !Array.isArray(report.evidence) ||
    report.evidence.length > 8
  )
    throw new Error("Research report identity invalid");
  if (
    ![
      "coverage-complete",
      "round-budget",
      "search-budget",
      "page-budget",
      "model-budget",
      "deadline",
      "no-progress",
      "clarification",
    ].includes(report.stopReason) ||
    !Number.isFinite(Date.parse(report.generatedAt)) ||
    !Number.isFinite(Date.parse(report.usage?.startedAt))
  )
    throw new Error("Invalid stop reason or timestamps");
  const p = plan(report.plan),
    a = assessment(report.assessment, p, report.evidence, r.crossCheck);
  if (JSON.stringify(a) !== JSON.stringify(report.assessment))
    throw new Error("Invalid coverage record");
  const result = answer(report.answer, report.evidence, a.selection),
    checks = verification(result, report.evidence, a.selection);
  if (JSON.stringify(checks) !== JSON.stringify(report.verification))
    throw new Error("Verification mismatch");
  if (
    r.crossCheck &&
    result.status === "answered" &&
    checks.some((c) => c.status !== "corroborated")
  )
    throw new Error("Corroboration required");
  if (result.claims.length && report.grounding !== "model-checked")
    throw new Error("Grounding required");
  if (
    !Array.isArray(report.rounds) ||
    report.rounds.length > r.maxRounds ||
    !Array.isArray(report.failures) ||
    !Array.isArray(report.omittedUrls)
  )
    throw new Error("Missing research trace");
  for (const [key, max] of [
    ["modelCalls", r.maxModelCalls],
    ["searches", r.maxSearches],
    ["pages", r.maxReadPages],
  ] as const)
    if (
      !Number.isSafeInteger(report.usage[key]) ||
      report.usage[key] < 0 ||
      report.usage[key] > max
    )
      throw new Error("Usage exceeds budget");
  if (
    report.stopReason === "coverage-complete" &&
    (a.coverage.some((c) => c.status !== "covered") ||
      a.selection.missing.length ||
      a.selection.conflicts.length)
  )
    throw new Error("Research is incomplete");
  if (
    report.evidence.some(
      (e) => !r.allowedOrigins.includes(new URL(e.uri).origin),
    )
  )
    throw new Error("Citation origin denied");
  return report;
}
