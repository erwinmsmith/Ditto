import { digest, identifier, object, text, strings } from "../evidence.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  seedDigest: string | null;
  maxRounds: number;
  maxModelCalls: number;
  deadlineSeconds: number;
}
const integer = (v: unknown, min: number, max: number) => {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid limit");
  return Number(v);
};
export function hash(v: unknown): string {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid digest");
  return s;
}
export function request(input: unknown): Request {
  const r = object(input);
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal),
    sourceDigest: hash(r.sourceDigest),
    seedDigest: r.seedDigest === null ? null : hash(r.seedDigest),
    maxRounds: integer(r.maxRounds, 1, 6),
    maxModelCalls: integer(r.maxModelCalls, 1, 16),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
export interface Sources {
  rows: {
    id: string;
    month: string;
    grossCents: number;
    refundCents: number;
    netCents: number;
    line: number;
    quote: string;
  }[];
  metrics: {
    baselineNetCents: number;
    currentNetCents: number;
    growthPercent: number;
  } | null;
  digest: string;
}
export function sources(raw: string): Sources {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.shift() !== "month,grossCents,refundCents")
    throw new Error("Invalid CSV header");
  const rows = lines.map((line, i) => {
    const [month, gross, refund, ...extra] = line.split(",");
    if (
      !month ||
      !/^2026-(07|08)$/.test(month) ||
      extra.length ||
      !/^\d+$/.test(gross ?? "") ||
      !/^\d+$/.test(refund ?? "")
    )
      throw new Error("Invalid CSV row");
    const grossCents = integer(Number(gross), 1, 1000000000),
      refundCents = integer(Number(refund), 0, grossCents);
    return {
      id: `sales-${month}`,
      month,
      grossCents,
      refundCents,
      netCents: grossCents - refundCents,
      line: i + 2,
      quote: line,
    };
  });
  if (new Set(rows.map((r) => r.month)).size !== rows.length || rows.length > 2)
    throw new Error("Duplicate period");
  rows.sort((a, b) => a.month.localeCompare(b.month));
  const baseline = rows.find((r) => r.month === "2026-07"),
    current = rows.find((r) => r.month === "2026-08");
  return {
    rows,
    metrics:
      baseline && current && baseline.netCents > 0
        ? {
            baselineNetCents: baseline.netCents,
            currentNetCents: current.netCents,
            growthPercent:
              Math.round(
                ((current.netCents - baseline.netCents) / baseline.netCents) *
                  10000,
              ) / 100,
          }
        : null,
    digest: digest(raw),
  };
}
export interface Draft {
  title: string;
  metrics: {
    baselineNetCents: number;
    currentNetCents: number;
    growthPercent: number;
  };
  interpretation: string;
  limitations: string[];
  actions: { owner: string; task: string }[];
  citations: { sourceId: string; quote: string }[];
}
export function draft(input: unknown): Draft {
  const d = object(input),
    m = object(d.metrics);
  if (!Number.isFinite(m.growthPercent)) throw new Error("Invalid metric");
  if (
    !Array.isArray(d.actions) ||
    d.actions.length > 5 ||
    !Array.isArray(d.citations) ||
    d.citations.length > 5
  )
    throw new Error("Invalid draft collections");
  return {
    title: text(d.title, 150),
    metrics: {
      baselineNetCents: integer(m.baselineNetCents, 0, 1000000000),
      currentNetCents: integer(m.currentNetCents, 0, 1000000000),
      growthPercent: Number(m.growthPercent),
    },
    interpretation: text(d.interpretation, 1500),
    limitations: strings(d.limitations, 5),
    actions: d.actions.map((v: unknown) => {
      const a = object(v);
      return { owner: text(a.owner, 100), task: text(a.task, 400) };
    }),
    citations: d.citations.map((v: unknown) => {
      const c = object(v);
      return { sourceId: identifier(c.sourceId), quote: text(c.quote, 200) };
    }),
  };
}
export interface Issue {
  field: string;
  message: string;
}
export interface Review {
  draftId: string;
  verdict: "pass" | "revise" | "needs-human";
  issues: Issue[];
}
export function review(input: unknown, id: string): Review {
  const r = object(input);
  if (
    r.draftId !== id ||
    !["pass", "revise", "needs-human"].includes(String(r.verdict)) ||
    !Array.isArray(r.issues) ||
    r.issues.length > 10
  )
    throw new Error("Invalid review identity or schema");
  const issues = r.issues.map((v: unknown) => {
    const i = object(v);
    return { field: text(i.field, 100), message: text(i.message, 600) };
  });
  if ((r.verdict === "pass") !== !issues.length)
    throw new Error("Inconsistent review verdict");
  return {
    draftId: hash(r.draftId),
    verdict: r.verdict as Review["verdict"],
    issues,
  };
}
export function check(d: Draft, s: Sources): Issue[] {
  const issues: Issue[] = [];
  const add = (field: string, message: string) =>
    issues.push({ field, message });
  if (!s.metrics)
    add("sources", "Two periods with a positive baseline are required.");
  else
    for (const [key, v] of Object.entries(s.metrics))
      if (d.metrics[key as keyof Draft["metrics"]] !== v)
        add(
          `metrics.${key}`,
          `Expected ${v}. Use net=gross-refunds; growth rounded to two decimals.`,
        );
  if (!d.limitations.length)
    add(
      "limitations",
      "Explain that two months cannot establish seasonality or causal effects.",
    );
  if (!d.actions.length)
    add(
      "actions",
      "Provide a proposed follow-up with a responsible role; do not claim it was executed.",
    );
  for (const row of s.rows) {
    const quote = row.quote;
    if (!d.citations.some((c) => c.sourceId === row.id && c.quote === quote))
      add("citations", `Cite ${row.id} with the exact CSV row: ${quote}`);
  }
  if (
    d.citations.some(
      (c) => !s.rows.some((r) => r.id === c.sourceId && c.quote === r.quote),
    )
  )
    add("citations", "Remove fabricated IDs or quotes.");
  return issues;
}
export const draftId = (d: Draft) => digest(JSON.stringify(d));
export interface Round {
  version: number;
  draftId: string;
  checkId: string;
  review: Review;
  issues: Issue[];
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  rounds: Round[];
  latestDraftId: string | null;
  acceptedDraftId: string | null;
  usage: { modelCalls: number; startedAt: string };
  generatedAt: string;
}
