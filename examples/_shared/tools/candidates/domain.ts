import { digest, identifier, object, strings, text } from "../evidence.ts";
export const angles = [
  "benefit",
  "workflow",
  "reassurance",
  "concise",
] as const;
export type Angle = (typeof angles)[number];
export function hash(v: unknown) {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid digest");
  return s;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit or score");
  return Number(v);
}
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  mode: "select" | "fuse";
  allowFallback: boolean;
  count: number;
  minScore: number;
  maxModelCalls: number;
  deadlineSeconds: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (
    !["select", "fuse"].includes(String(r.mode)) ||
    typeof r.allowFallback !== "boolean"
  )
    throw new Error("Invalid selection mode");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal),
    sourceDigest: hash(r.sourceDigest),
    mode: r.mode as Request["mode"],
    allowFallback: r.allowFallback,
    count: integer(r.count, 2, 4),
    minScore: integer(r.minScore, 0, 25),
    maxModelCalls: integer(r.maxModelCalls, 1, 16),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Catalog {
  product: string;
  cta: string;
  facts: { id: string; text: string }[];
}
export function catalog(v: unknown): Catalog {
  const c = object(v);
  if (!Array.isArray(c.facts) || c.facts.length > 8)
    throw new Error("Invalid catalog");
  const facts = c.facts.map((v: unknown) => {
    const f = object(v);
    return { id: identifier(f.id), text: text(f.text, 80) };
  });
  if (new Set(facts.map((f) => f.id)).size !== facts.length)
    throw new Error("Duplicate facts");
  return { product: text(c.product, 80), cta: text(c.cta, 30), facts };
}
export interface Candidate {
  headline: string;
  body: string;
  cta: string;
  factIds: string[];
}
export function candidate(v: unknown): Candidate {
  const c = object(v);
  return {
    headline: text(c.headline, 300),
    body: text(c.body, 1500),
    cta: text(c.cta, 100),
    factIds: strings(c.factIds, 8).map(identifier),
  };
}
export const candidateId = (c: Candidate) => digest(JSON.stringify(c));
export const normalized = (c: Candidate) =>
  [c.headline, c.body, c.cta]
    .join("")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{Z}\s]/gu, "");
export function check(c: Candidate, s: Catalog): string[] {
  const issues: string[] = [];
  if ([...c.headline].length > 40)
    issues.push("Headline exceeds 40 characters.");
  if ([...c.body].length > 160) issues.push("Body exceeds 160 characters.");
  if (c.cta !== s.cta) issues.push("Use the approved CTA exactly.");
  if (c.factIds.length < 2 || new Set(c.factIds).size !== c.factIds.length)
    issues.push("Cite at least two distinct product facts.");
  for (const id of c.factIds) {
    const f = s.facts.find((f) => f.id === id);
    if (!f || !c.body.includes(f.text))
      issues.push(`Unsupported or unquoted fact: ${id}`);
  }
  return issues;
}
export interface Assessment {
  candidateId: string;
  verdict: "pass" | "reject";
  scores: { clarity: number; fit: number; credibility: number };
  rationale: string;
  issues: string[];
}
export function assessment(v: unknown, id: string): Assessment {
  const a = object(v),
    s = object(a.scores);
  if (a.candidateId !== id || !["pass", "reject"].includes(String(a.verdict)))
    throw new Error("Invalid assessment identity or verdict");
  const issues = strings(a.issues, 8);
  if ((a.verdict === "pass") !== !issues.length)
    throw new Error("Contradictory assessment");
  return {
    candidateId: hash(a.candidateId),
    verdict: a.verdict as Assessment["verdict"],
    scores: {
      clarity: integer(s.clarity, 0, 5),
      fit: integer(s.fit, 0, 5),
      credibility: integer(s.credibility, 0, 5),
    },
    rationale: text(a.rationale, 800),
    issues,
  };
}
export const score = (a: Assessment) =>
  2 * a.scores.clarity + 2 * a.scores.fit + a.scores.credibility;
export interface Grade {
  candidateId: string;
  sourceDigest: string;
  issues: string[];
  assessment: Assessment | null;
}
export const eligible = (g: Grade, r: Request) =>
  !g.issues.length &&
  g.assessment?.verdict === "pass" &&
  score(g.assessment) >= r.minScore;
export interface Entry {
  slot: number;
  angle: Angle;
  candidateId: string | null;
  gradeId: string | null;
  error: string | null;
}
export interface Fusion {
  headlineFrom: string;
  bodyFrom: string;
  ctaFrom: string;
  reason: string;
}
export function fusion(v: unknown, parents: string[]): Fusion {
  const f = object(v);
  const ids = [hash(f.headlineFrom), hash(f.bodyFrom), hash(f.ctaFrom)];
  if (
    ids.some((id) => !parents.includes(id)) ||
    new Set(ids).size < 2 ||
    ids[0] === ids[1]
  )
    throw new Error("Fusion requires two approved parents");
  return {
    headlineFrom: ids[0]!,
    bodyFrom: ids[1]!,
    ctaFrom: ids[2]!,
    reason: text(f.reason, 600),
  };
}
export function combine(f: Fusion, parents: Map<string, Candidate>): Candidate {
  const h = parents.get(f.headlineFrom),
    b = parents.get(f.bodyFrom),
    c = parents.get(f.ctaFrom);
  if (!h || !b || !c) throw new Error("Missing fusion parent");
  const merged = {
    headline: h.headline,
    body: b.body,
    cta: c.cta,
    factIds: b.factIds,
  };
  if ([...parents.values()].some((p) => normalized(p) === normalized(merged)))
    throw new Error("Fusion must create a distinct combination");
  return merged;
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  entries: Entry[];
  ranking: { candidateId: string; gradeId: string; score: number }[];
  fusion: Fusion | null;
  fusionGradeId: string | null;
  fusionError: string | null;
  applied: "select" | "fuse" | "fallback" | null;
  finalId: string | null;
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
