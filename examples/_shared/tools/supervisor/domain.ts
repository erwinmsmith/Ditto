import { digest, identifier, object, text, strings } from "../evidence.ts";
import {
  sources as baseSources,
  evidence as baseEvidence,
  hash,
  type Sources as BaseSources,
} from "../multi-agent/domain.ts";
export const roles = ["engineering", "operations", "verification"] as const;
export type Specialist = (typeof roles)[number];
export type Agent = Specialist | "supervisor";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  maxRounds: number;
  maxModelCalls: number;
  maxAgentAttempts: number;
  deadlineSeconds: number;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit");
  return Number(v);
}
export function request(v: unknown): Request {
  const r = object(v);
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal, 2000),
    sourceDigest: hash(r.sourceDigest),
    maxRounds: integer(r.maxRounds, 1, 8),
    maxModelCalls: integer(r.maxModelCalls, 1, 20),
    maxAgentAttempts: integer(r.maxAgentAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Sources {
  base: BaseSources;
  verification: {
    runId: string;
    total: number;
    passed: number;
    criticalOpen: number;
  } | null;
}
export function sources(v: unknown): Sources {
  const s = object(v),
    base = baseSources(s.base);
  let verification: Sources["verification"] = null;
  if (s.verification !== null) {
    const x = object(s.verification),
      total = integer(x.total, 1, 100000);
    verification = {
      runId: identifier(x.runId),
      total,
      passed: integer(x.passed, 0, total),
      criticalOpen: integer(x.criticalOpen, 0, 1000),
    };
    if (verification.total !== base.engineering.total)
      throw new Error("Rerun coverage count differs from initial tests");
  }
  return { base, verification };
}
export interface Evidence {
  agent: Specialist;
  releaseId: string;
  verdict: "ready" | "blocked" | "unknown";
  facts: { id: string; quote: string }[];
}
export function evidence(s: Sources, agent: Specialist): Evidence {
  if (agent !== "verification") return baseEvidence(s.base, agent);
  const v = s.verification;
  return {
    agent,
    releaseId: s.base.releaseId,
    verdict: v
      ? v.passed === v.total && v.criticalOpen === 0
        ? "ready"
        : "blocked"
      : "unknown",
    facts: v
      ? [
          {
            id: "rerun",
            quote: `Run ${v.runId}: ${v.passed}/${v.total} tests passed.`,
          },
          {
            id: "defects",
            quote: `${v.criticalOpen} critical defects open in ${v.runId}.`,
          },
        ]
      : [{ id: "missing", quote: "No verified rerun record is available." }],
  };
}
export interface Finding {
  agent: Specialist;
  assignmentId: string;
  releaseId: string;
  verdict: Evidence["verdict"];
  summary: string;
  citations: Evidence["facts"];
}
export function finding(
  v: unknown,
  e: Evidence,
  assignmentId: string,
): Finding {
  const f = object(v);
  if (
    f.agent !== e.agent ||
    f.assignmentId !== assignmentId ||
    f.releaseId !== e.releaseId ||
    f.verdict !== e.verdict ||
    !Array.isArray(f.citations) ||
    f.citations.length !== e.facts.length
  )
    throw new Error("Invalid specialist identity or verdict");
  const citations = f.citations.map((x) => {
    const c = object(x);
    if (!e.facts.some((f) => f.id === c.id && f.quote === c.quote))
      throw new Error("Unsupported citation");
    return { id: String(c.id), quote: String(c.quote) };
  });
  if (new Set(citations.map((c) => c.id)).size !== e.facts.length)
    throw new Error("Incomplete citations");
  return {
    agent: e.agent,
    assignmentId,
    releaseId: e.releaseId,
    verdict: e.verdict,
    summary: text(f.summary, 1500),
    citations,
  };
}
export interface Saved {
  requestDigest: string;
  finding: Finding;
  parentId: string | null;
}
export const resultId = (s: Saved) => digest(JSON.stringify(s));
export interface Handoff {
  resultId: string;
  finding: Finding;
}
export interface State {
  results: Partial<Record<Specialist, Handoff>>;
  attempts: Record<Specialist, number>;
  errors: Record<Specialist, string[]>;
}
export function initialState(): State {
  return {
    results: {},
    attempts: { engineering: 0, operations: 0, verification: 0 },
    errors: { engineering: [], operations: [], verification: [] },
  };
}
export function next(state: State, r: Request) {
  const missing = (["engineering", "operations"] as const).filter(
      (a) => !state.results[a],
    ),
    needsVerification =
      state.results.engineering?.finding.verdict === "blocked";
  const required: Specialist[] = [
    ...missing,
    ...(!missing.length && needsVerification && !state.results.verification
      ? ["verification" as const]
      : []),
  ];
  const eligible = required.filter(
    (a) => state.attempts[a] < r.maxAgentAttempts,
  );
  const complete =
    missing.length === 0 &&
    (!needsVerification || !!state.results.verification);
  const unknown =
    needsVerification &&
    state.results.verification?.finding.verdict === "unknown";
  return {
    eligible,
    finishAllowed: complete && !unknown,
    escalateAllowed: (!complete && !eligible.length) || unknown,
    verdict:
      complete && !unknown
        ? state.results.operations!.finding.verdict === "blocked" ||
          (needsVerification
            ? state.results.verification!.finding.verdict
            : state.results.engineering!.finding.verdict) === "blocked"
          ? "blocked"
          : "ready"
        : null,
  };
}
export interface Decision {
  action: "delegate" | "finish" | "escalate";
  reviewedIds: string[];
  assignments: { agent: Specialist; task: string }[];
  reason: string;
  conclusion: {
    verdict: "ready" | "blocked";
    summary: string;
    evidenceIds: string[];
  } | null;
}
export function decision(v: unknown, state: State, r: Request): Decision {
  const d = object(v),
    available = next(state, r),
    ids = Object.values(state.results)
      .map((x) => x.resultId)
      .sort(),
    reviewedIds = strings(d.reviewedIds, 3).map(hash);
  if (JSON.stringify([...reviewedIds].sort()) !== JSON.stringify(ids))
    throw new Error("Supervisor must review every current handoff");
  if (!Array.isArray(d.assignments) || d.assignments.length > 3)
    throw new Error("Invalid assignments");
  const assignments = d.assignments.map((v) => {
    const a = object(v);
    if (!roles.includes(a.agent as Specialist))
      throw new Error("Unknown agent");
    return { agent: a.agent as Specialist, task: text(a.task, 600) };
  });
  if (new Set(assignments.map((x) => x.agent)).size !== assignments.length)
    throw new Error("Duplicate delegation");
  let conclusion: Decision["conclusion"] = null;
  if (d.action === "delegate") {
    if (
      !assignments.length ||
      assignments.some((a) => !available.eligible.includes(a.agent)) ||
      d.conclusion !== null
    )
      throw new Error("Delegation violates readiness or retry policy");
  } else if (d.action === "finish") {
    if (!available.finishAllowed || assignments.length)
      throw new Error("Premature completion");
    const c = object(d.conclusion),
      evidenceIds =
        c.evidenceIds === undefined
          ? [...reviewedIds]
          : strings(c.evidenceIds, 3).map(hash);
    if (
      c.verdict !== available.verdict ||
      JSON.stringify([...evidenceIds].sort()) !== JSON.stringify(ids)
    )
      throw new Error("Unsupported conclusion");
    conclusion = {
      verdict: c.verdict as "ready" | "blocked",
      summary: text(c.summary, 2500),
      evidenceIds,
    };
  } else if (d.action === "escalate") {
    if (
      !available.escalateAllowed ||
      assignments.length ||
      d.conclusion !== null
    )
      throw new Error("Invalid escalation");
  } else throw new Error("Invalid supervisor action");
  return {
    action: d.action,
    reviewedIds,
    assignments,
    reason: text(d.reason, 1500),
    conclusion,
  };
}
export interface Round {
  round: number;
  decision: Decision;
  outcomes: {
    agent: Specialist;
    assignmentId: string;
    resultId: string | null;
    error: string | null;
  }[];
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  rounds: Round[];
  state: State;
  conclusion: Decision["conclusion"];
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
