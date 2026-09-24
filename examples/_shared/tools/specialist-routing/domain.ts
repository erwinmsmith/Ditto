import { isDeepStrictEqual } from "node:util";
import { digest, identifier, object, text } from "../evidence.ts";
export const roles = ["finance", "legal", "data", "coding"] as const;
export type Specialist = (typeof roles)[number];
export type Agent = Specialist | "router";
export const intents = {
  finance: "reimbursement",
  legal: "contract-review",
  data: "sales-summary",
  coding: "discount-fix",
} as const;
export const actions = {
  finance: "calculate-reimbursement",
  legal: "check-contract",
  data: "query-sales",
  coding: "repair-discount",
} as const;
export function specialist(v: unknown): Specialist {
  if (!roles.includes(v as Specialist)) throw new Error("Unknown specialist");
  return v as Specialist;
}
export function hash(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new Error("Invalid digest");
  return v;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit");
  return Number(v);
}
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  sourceDigest: string;
  allowedRoles: Specialist[];
  minConfidence: number;
  maxModelCalls: number;
  maxAttempts: number;
  deadlineSeconds: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (
    !Array.isArray(r.allowedRoles) ||
    new Set(r.allowedRoles).size !== r.allowedRoles.length ||
    typeof r.minConfidence !== "number" ||
    !Number.isFinite(r.minConfidence) ||
    r.minConfidence < 0 ||
    r.minConfidence > 1
  )
    throw new Error("Invalid routing policy");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    question: text(r.question, 2000),
    sourceDigest: hash(r.sourceDigest),
    allowedRoles: r.allowedRoles.map(specialist),
    minConfidence: r.minConfidence,
    maxModelCalls: integer(r.maxModelCalls, 1, 20),
    maxAttempts: integer(r.maxAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Route {
  domains: Specialist[];
  intent: string | null;
  confidence: number;
  reason: string;
  question: string | null;
  status: "selected" | "needs-clarification" | "unavailable";
  selected: Specialist | null;
}
export function route(v: unknown, r: Request): Route {
  const o = object(v);
  if (
    !Array.isArray(o.domains) ||
    o.domains.length > 4 ||
    new Set(o.domains).size !== o.domains.length ||
    typeof o.confidence !== "number" ||
    !Number.isFinite(o.confidence) ||
    o.confidence < 0 ||
    o.confidence > 1
  )
    throw new Error("Invalid classification");
  const domains = o.domains.map(specialist),
    single = domains.length === 1 ? domains[0]! : null;
  if (single ? o.intent !== intents[single] : o.intent !== null)
    throw new Error("Intent/domain mismatch");
  const enough = single !== null && o.confidence >= r.minConfidence;
  const status = !enough
    ? "needs-clarification"
    : r.allowedRoles.includes(single)
      ? "selected"
      : "unavailable";
  if (status === "selected" && o.question !== null)
    throw new Error("Unexpected clarification");
  const question = o.question === null ? null : text(o.question, 800);
  if (status === "needs-clarification" && !question)
    throw new Error("Ask a concrete clarification");
  return {
    domains,
    intent: single ? intents[single] : null,
    confidence: o.confidence,
    reason: text(o.reason, 1000),
    question,
    status,
    selected: status === "selected" ? single : null,
  };
}
export interface Fact {
  id: string;
  quote: string;
}
export interface Sources {
  codeDigest: string;
  finance: {
    claimId: string;
    mealCents: number;
    travelCents: number;
    mealCapCents: number;
  };
  legal: {
    contractId: string;
    noticeDays: number;
    requiredNoticeDays: number;
    dataReturnDays: number | null;
  };
  data: {
    id: string;
    region: string;
    cents: number;
    status: "paid" | "cancelled";
  }[];
}
export function sources(v: unknown): Sources {
  const o = object(v),
    f = object(o.finance),
    l = object(o.legal);
  if (!Array.isArray(o.data) || !o.data.length || o.data.length > 100)
    throw new Error("Invalid sales");
  const data = o.data.map((x) => {
    const s = object(x);
    if (s.status !== "paid" && s.status !== "cancelled")
      throw new Error("Invalid sales status");
    return {
      id: identifier(s.id),
      region: identifier(s.region),
      cents: integer(s.cents, 0, 10000000),
      status: s.status as "paid" | "cancelled",
    };
  });
  if (new Set(data.map((x) => x.id)).size !== data.length)
    throw new Error("Duplicate sale");
  return {
    codeDigest: hash(o.codeDigest),
    finance: {
      claimId: identifier(f.claimId),
      mealCents: integer(f.mealCents, 0, 10000000),
      travelCents: integer(f.travelCents, 0, 10000000),
      mealCapCents: integer(f.mealCapCents, 0, 10000000),
    },
    legal: {
      contractId: identifier(l.contractId),
      noticeDays: integer(l.noticeDays, 0, 365),
      requiredNoticeDays: integer(l.requiredNoticeDays, 0, 365),
      dataReturnDays:
        l.dataReturnDays === null ? null : integer(l.dataReturnDays, 0, 365),
    },
    data,
  };
}
export interface Evidence {
  role: Specialist;
  intent: string;
  action: string;
  target: string;
  facts: Fact[];
}
export function evidence(s: Sources, role: Specialist): Evidence {
  const f = s.finance,
    l = s.legal;
  return {
    role,
    intent: intents[role],
    action: actions[role],
    target:
      role === "finance"
        ? f.claimId
        : role === "legal"
          ? l.contractId
          : role === "data"
            ? "sales"
            : "discount.mjs",
    facts:
      role === "finance"
        ? [
            {
              id: "claim",
              quote: `Claim ${f.claimId}: meal ${f.mealCents} cents; travel ${f.travelCents} cents.`,
            },
            {
              id: "policy",
              quote: `Meal reimbursement cap: ${f.mealCapCents} cents; travel reimbursed as submitted.`,
            },
          ]
        : role === "legal"
          ? [
              {
                id: "contract",
                quote: `Contract ${l.contractId}: termination notice ${l.noticeDays} days; data return deadline ${l.dataReturnDays ?? "missing"}.`,
              },
              {
                id: "checklist",
                quote: `Internal checklist: notice at least ${l.requiredNoticeDays} days and an explicit data return deadline.`,
              },
            ]
          : role === "data"
            ? [
                {
                  id: "schema",
                  quote:
                    "sales(id, region, cents, status); include paid orders only, group by region.",
                },
                {
                  id: "dataset",
                  quote: `${s.data.length} sales rows in the task database; all money values use integer cents.`,
                },
              ]
            : [
                {
                  id: "bug",
                  quote:
                    "discount.mjs incorrectly interprets basis points as percent.",
                },
                {
                  id: "spec",
                  quote:
                    "discount(10000, 1500) must return 8500; round final cents to the nearest integer.",
                },
              ],
  };
}
export function citations(v: unknown, facts: Fact[]): Fact[] {
  if (!Array.isArray(v) || v.length !== facts.length)
    throw new Error("Incomplete citations");
  const out = v.map((x) => {
    const c = object(x);
    if (!facts.some((f) => f.id === c.id && f.quote === c.quote))
      throw new Error("Unsupported citation");
    return { id: String(c.id), quote: String(c.quote) };
  });
  if (new Set(out.map((x) => x.id)).size !== facts.length)
    throw new Error("Duplicate citation");
  return out;
}
export interface Plan {
  matchesRequest: true;
  role: Specialist;
  intent: string;
  action: string;
  target: string;
  summary: string;
  citations: Fact[];
}
export function plan(v: unknown, e: Evidence): Plan {
  const p = object(v);
  if (
    p.matchesRequest !== true ||
    p.role !== e.role ||
    p.intent !== e.intent ||
    p.action !== e.action ||
    p.target !== e.target
  )
    throw new Error("Specialist plan outside scope");
  return {
    matchesRequest: true,
    role: e.role,
    intent: e.intent,
    action: e.action,
    target: e.target,
    summary: text(p.summary, 1200),
    citations: citations(p.citations, e.facts),
  };
}
export interface Result {
  role: Specialist;
  values: Record<string, unknown>;
  facts: Fact[];
}
export interface Answer {
  role: Specialist;
  summary: string;
  values: Record<string, unknown>;
  citations: Fact[];
}
export function answer(v: unknown, result: Result): Answer {
  const a = object(v),
    values = object(a.values);
  if (a.role !== result.role || !isDeepStrictEqual(values, result.values))
    throw new Error("Answer contradicts executed result");
  return {
    role: result.role,
    summary: text(a.summary, 2500),
    values: result.values,
    citations: citations(a.citations, result.facts),
  };
}
export interface Receipt {
  requestDigest: string;
  routeId: string;
  plan: Plan;
  result: Result;
  artifacts: { path: string; digest: string }[];
}
export interface Report {
  requestId: string;
  status: "completed" | "needs-clarification" | "needs-human" | "partial";
  stopReason: string;
  clarification: string | null;
  route: Route | null;
  receiptId: string | null;
  answer: Answer | null;
  errors: { stage: string; attempt: number; code: string }[];
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
export const idOf = (v: unknown) => digest(JSON.stringify(v));
