import { isDeepStrictEqual } from "node:util";
import { digest, identifier, object, text, strings } from "../evidence.ts";
export const roles = ["product", "finance", "reliability"] as const;
export const topics = ["benefit", "cost", "reliability"] as const;
export type Perspective = (typeof roles)[number];
export type Topic = (typeof topics)[number];
export type Agent = Perspective | "comparison" | "synthesis";
export type Judgment = "positive" | "concern" | "unknown";
export const idOf = (v: unknown) => digest(JSON.stringify(v));
export function hash(v: unknown) {
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
  maxModelCalls: number;
  maxAttempts: number;
  deadlineSeconds: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    question: text(r.question, 2000),
    sourceDigest: hash(r.sourceDigest),
    maxModelCalls: integer(r.maxModelCalls, 1, 20),
    maxAttempts: integer(r.maxAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Sources {
  proposalId: string;
  upliftPercent: number;
  forecastRevenueCents: number;
  pilotCostCents: number | null;
  errorBps: number;
  rollbackVerified: boolean;
  oncallAssigned: boolean;
}
export function sources(v: unknown): Sources {
  const s = object(v);
  if (
    typeof s.rollbackVerified !== "boolean" ||
    typeof s.oncallAssigned !== "boolean"
  )
    throw new Error("Invalid readiness evidence");
  return {
    proposalId: identifier(s.proposalId),
    upliftPercent: integer(s.upliftPercent, 0, 100),
    forecastRevenueCents: integer(s.forecastRevenueCents, 0, 100000000),
    pilotCostCents:
      s.pilotCostCents === null
        ? null
        : integer(s.pilotCostCents, 0, 100000000),
    errorBps: integer(s.errorBps, 0, 10000),
    rollbackVerified: s.rollbackVerified,
    oncallAssigned: s.oncallAssigned,
  };
}
export interface Fact {
  id: string;
  quote: string;
}
export function facts(s: Sources): Record<Topic, Fact[]> {
  return {
    benefit: [
      {
        id: "uplift",
        quote: `Observed conversion uplift: ${s.upliftPercent} percent.`,
      },
      {
        id: "forecast",
        quote: `Forecast incremental revenue: ${s.forecastRevenueCents} cents; this is an estimate, not realized revenue.`,
      },
    ],
    cost: [
      {
        id: "cost",
        quote:
          s.pilotCostCents === null
            ? "Pilot cost estimate is missing."
            : `Pilot cost estimate: ${s.pilotCostCents} cents.`,
      },
    ],
    reliability: [
      {
        id: "errors",
        quote: `Observed error rate: ${s.errorBps} basis points.`,
      },
      { id: "rollback", quote: `Rollback verified: ${s.rollbackVerified}.` },
      { id: "oncall", quote: `On-call assigned: ${s.oncallAssigned}.` },
    ],
  };
}
export const criteria = {
  product:
    "Benefit positive at uplift >=5%; cost positive at <=1800000 cents; reliability positive at errors <=100 bps with verified rollback. Emphasize user value and a bounded experiment, but acknowledge other roles' stricter concerns.",
  finance:
    "Benefit positive when forecast revenue >= known pilot cost (include cost fact as a benefit citation); cost positive at <=1000000 cents; reliability positive at errors <=50 bps with verified rollback. Emphasize cost discipline and forecast uncertainty.",
  reliability:
    "Benefit positive at uplift >=8%; cost positive at <=1500000 cents; reliability positive only at errors <=10 bps, verified rollback and assigned on-call. Emphasize operational readiness and reversibility.",
} as const;
export interface Evidence {
  agent: Perspective;
  proposalId: string;
  criteria: string;
  facts: Record<Topic, Fact[]>;
  expected: Record<Topic, Judgment>;
}
export function evidence(s: Sources, agent: Perspective): Evidence {
  const known = s.pilotCostCents !== null,
    f = facts(s);
  if (agent === "finance") f.benefit = [...f.benefit, ...f.cost];
  return {
    agent,
    proposalId: s.proposalId,
    criteria: criteria[agent],
    facts: f,
    expected: {
      benefit:
        agent === "finance"
          ? !known
            ? "unknown"
            : s.forecastRevenueCents >= s.pilotCostCents!
              ? "positive"
              : "concern"
          : s.upliftPercent >= (agent === "product" ? 5 : 8)
            ? "positive"
            : "concern",
      cost: !known
        ? "unknown"
        : s.pilotCostCents! <=
            (agent === "product"
              ? 1800000
              : agent === "finance"
                ? 1000000
                : 1500000)
          ? "positive"
          : "concern",
      reliability:
        s.errorBps <=
          (agent === "product" ? 100 : agent === "finance" ? 50 : 10) &&
        s.rollbackVerified &&
        (agent !== "reliability" || s.oncallAssigned)
          ? "positive"
          : "concern",
    },
  };
}
function citations(v: unknown, expected: Fact[]): Fact[] {
  if (!Array.isArray(v) || v.length !== expected.length)
    throw new Error("Incomplete evidence");
  const cs = v.map((x) => {
    const c = object(x);
    if (!expected.some((f) => f.id === c.id && f.quote === c.quote))
      throw new Error("Unsupported citation");
    return { id: String(c.id), quote: String(c.quote) };
  });
  if (new Set(cs.map((c) => c.id)).size !== expected.length)
    throw new Error("Duplicate citation");
  return cs;
}
export interface View {
  agent: Perspective;
  proposalId: string;
  position: "support" | "conditional" | "oppose";
  summary: string;
  assessments: {
    topic: Topic;
    judgment: Judgment;
    reason: string;
    citations: Fact[];
  }[];
  tradeoff: string;
}
export function view(v: unknown, e: Evidence): View {
  const x = object(v);
  if (
    x.agent !== e.agent ||
    x.proposalId !== e.proposalId ||
    !["support", "conditional", "oppose"].includes(String(x.position)) ||
    !Array.isArray(x.assessments) ||
    x.assessments.length !== 3
  )
    throw new Error("Invalid perspective");
  const assessments = topics.map((topic) => {
    const matches = (x.assessments as unknown[])
      .map(object)
      .filter((a) => a.topic === topic);
    if (matches.length !== 1 || matches[0]!.judgment !== e.expected[topic])
      throw new Error("Assessment contradicts disclosed criteria");
    const a = matches[0]!;
    return {
      topic,
      judgment: e.expected[topic],
      reason: text(a.reason, 1000),
      citations: citations(a.citations, e.facts[topic]),
    };
  });
  if (
    x.position === "support" &&
    assessments.some((a) => a.judgment !== "positive")
  )
    throw new Error("Unconditional support contradicts concerns");
  return {
    agent: e.agent,
    proposalId: e.proposalId,
    position: x.position as View["position"],
    summary: text(x.summary, 1500),
    assessments,
    tradeoff: text(x.tradeoff, 1000),
  };
}
export interface SavedView {
  requestDigest: string;
  view: View;
}
export interface Handoff {
  id: string;
  view: View;
}
export interface Matrix {
  missingAgents: Perspective[];
  topics: {
    topic: Topic;
    kind: "consensus" | "disagreement" | "agreement-among-available";
    groups: { judgment: Judgment; agents: Perspective[] }[];
  }[];
}
export function matrix(views: Handoff[]): Matrix {
  if (
    !views.length ||
    new Set(views.map((v) => v.view.agent)).size !== views.length ||
    views.some((v) => !roles.includes(v.view.agent))
  )
    throw new Error("Invalid opinion set");
  const missingAgents = roles.filter(
    (a) => !views.some((v) => v.view.agent === a),
  );
  return {
    missingAgents,
    topics: topics.map((topic) => {
      const groups = (["positive", "concern", "unknown"] as const)
        .map((judgment) => ({
          judgment,
          agents: roles.filter((a) =>
            views.some(
              (v) =>
                v.view.agent === a &&
                v.view.assessments.find((x) => x.topic === topic)!.judgment ===
                  judgment,
            ),
          ),
        }))
        .filter((g) => g.agents.length);
      return {
        topic,
        kind:
          groups.length > 1
            ? "disagreement"
            : missingAgents.length
              ? "agreement-among-available"
              : "consensus",
        groups,
      };
    }),
  };
}
export interface Comparison {
  reviewedIds: string[];
  summary: string;
  topics: {
    topic: Topic;
    kind: Matrix["topics"][number]["kind"];
    summary: string;
  }[];
  matrix: Matrix;
}
export function comparison(v: unknown, views: Handoff[]): Comparison {
  const c = object(v),
    m = matrix(views),
    ids = views.map((v) => v.id).sort(),
    reviewedIds = strings(c.reviewedIds, 3).map(hash);
  if (
    !isDeepStrictEqual([...reviewedIds].sort(), ids) ||
    !Array.isArray(c.topics) ||
    c.topics.length !== 3
  )
    throw new Error("Comparison must review every opinion");
  const notes = m.topics.map((t) => {
    const matches = (c.topics as unknown[])
      .map(object)
      .filter((x) => x.topic === t.topic);
    if (matches.length !== 1 || matches[0]!.kind !== t.kind)
      throw new Error("Consensus or disagreement misrepresented");
    return {
      topic: t.topic,
      kind: t.kind,
      summary: text(matches[0]!.summary, 1500),
    };
  });
  if (c.matrix !== undefined && !isDeepStrictEqual(c.matrix, m))
    throw new Error("Comparison matrix changed");
  return {
    reviewedIds,
    summary: text(c.summary, 1800),
    topics: notes,
    matrix: m,
  };
}
export function policy(s: Sources, c: Comparison) {
  const incomplete = c.matrix.missingAgents.length > 0,
    unknown = c.matrix.topics.some((t) =>
      t.groups.some((g) => g.judgment === "unknown"),
    );
  const blockers = [
    ...(s.pilotCostCents === null ? ["cost-estimate-missing"] : []),
    ...(!s.rollbackVerified ? ["rollback-unverified"] : []),
    ...(!s.oncallAssigned ? ["oncall-unassigned"] : []),
    ...(s.errorBps > 100 ? ["error-rate-above-hard-limit"] : []),
  ];
  const unresolvedTopics = topics.filter(
    (topic) =>
      c.matrix.topics.some(
        (t) =>
          t.topic === topic &&
          (t.kind === "disagreement" ||
            t.groups.some((g) => g.judgment === "unknown")),
      ) ||
      (topic === "reliability" &&
        blockers.some((b) => b !== "cost-estimate-missing")),
  );
  return {
    allowed:
      incomplete || unknown
        ? ["defer"]
        : blockers.length
          ? ["revise", "defer"]
          : ["pilot", "revise", "defer"],
    blockers,
    unresolvedTopics,
    missingAgents: c.matrix.missingAgents,
  };
}
export interface Synthesis {
  recommendation: "pilot" | "revise" | "defer";
  summary: string;
  conditions: { topic: Topic; action: string }[];
  unresolvedTopics: Topic[];
  missingAgents: Perspective[];
  comparisonId: string;
}
export function synthesis(v: unknown, c: Comparison, s: Sources): Synthesis {
  const x = object(v),
    p = policy(s, c),
    unresolvedTopics = strings(x.unresolvedTopics, 3),
    missingAgents = strings(x.missingAgents, 3);
  if (
    !p.allowed.includes(String(x.recommendation)) ||
    !isDeepStrictEqual(
      [...unresolvedTopics].sort(),
      [...p.unresolvedTopics].sort(),
    ) ||
    !isDeepStrictEqual(
      [...missingAgents].sort(),
      [...p.missingAgents].sort(),
    ) ||
    !Array.isArray(x.conditions) ||
    x.conditions.length > 8
  )
    throw new Error(
      "Synthesis suppresses disagreement, missing views or blockers",
    );
  const conditions = x.conditions.map((v) => {
    const a = object(v);
    if (!topics.includes(a.topic as Topic)) throw new Error("Unknown topic");
    return { topic: a.topic as Topic, action: text(a.action, 1200) };
  });
  if (p.unresolvedTopics.some((t) => !conditions.some((c) => c.topic === t)))
    throw new Error("Every unresolved topic needs a follow-up");
  if (x.comparisonId !== undefined && x.comparisonId !== idOf(c))
    throw new Error("Synthesis lineage changed");
  return {
    recommendation: x.recommendation as Synthesis["recommendation"],
    summary: text(x.summary, 3000),
    conditions,
    unresolvedTopics: unresolvedTopics as Topic[],
    missingAgents: missingAgents as Perspective[],
    comparisonId: idOf(c),
  };
}
export interface Entry {
  agent: Perspective;
  attempts: number;
  errors: string[];
  resultId: string | null;
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  entries: Entry[];
  comparison: Comparison | null;
  synthesis: Synthesis | null;
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
