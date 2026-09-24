import {
  digest,
  identifier,
  object,
  text,
  strings,
  selection,
  answer,
  type Plan,
  type Selection,
  type Answer,
} from "../evidence.ts";
export {
  digest,
  json,
  object,
  plan,
  selection,
  answer,
  verify,
} from "../evidence.ts";
export type { Plan, Selection, Answer } from "../evidence.ts";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  allowedOrigins: string[];
  referenceUrls: string[];
  maxQueries: number;
  maxPages: number;
  crossCheck: boolean;
  allowPartial: boolean;
}
export function canonical(value: unknown): string {
  const u = new URL(text(value, 2048));
  if (u.username || u.password || !["https:", "http:"].includes(u.protocol))
    throw new Error("Invalid web URL");
  u.hash = "";
  return u.href;
}
export function request(value: unknown): Request {
  const r = object(value),
    allowedOrigins = strings(r.allowedOrigins, 12).map((v) => {
      const u = new URL(canonical(v));
      if (u.href !== u.origin + "/")
        throw new Error("Policy must contain origins, not paths");
      return u.origin;
    });
  if (
    !allowedOrigins.length ||
    new Set(allowedOrigins).size !== allowedOrigins.length
  )
    throw new Error("Invalid origin policy");
  const referenceUrls = strings(r.referenceUrls, 3).map(canonical);
  if (referenceUrls.some((v) => !allowedOrigins.includes(new URL(v).origin)))
    throw new Error("Reference origin denied");
  if (
    !Number.isSafeInteger(r.maxQueries) ||
    Number(r.maxQueries) < 1 ||
    Number(r.maxQueries) > 3 ||
    !Number.isSafeInteger(r.maxPages) ||
    Number(r.maxPages) < 1 ||
    Number(r.maxPages) > 6 ||
    typeof r.crossCheck !== "boolean" ||
    typeof r.allowPartial !== "boolean"
  )
    throw new Error("Invalid web budget or policy");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    question: text(r.question, 1200),
    allowedOrigins,
    referenceUrls,
    maxQueries: Number(r.maxQueries),
    maxPages: Number(r.maxPages),
    crossCheck: r.crossCheck,
    allowPartial: r.allowPartial,
  };
}
export interface Hit {
  url: string;
  title: string;
  snippet: string;
}
export interface Evidence {
  id: string;
  pageKey: string;
  uri: string;
  title: string;
  hostname: string;
  fetchedAt: string;
  snapshot: string;
  startLine: number;
  endLine: number;
  text: string;
}
export interface Page {
  requestedUrl: string;
  url: string;
  title: string;
  fetchedAt: string;
  snapshot: string;
  textHash: string;
  blocks: string[];
}
export interface Failure {
  stage: "search" | "read";
  target: string;
  code: string;
}
export interface Collected {
  evidence: Evidence[];
  pages: Page[];
  failures: Failure[];
  omittedUrls: string[];
}
export interface Report {
  requestId: string;
  question: string;
  plan: Plan;
  selection: Selection;
  evidence: Evidence[];
  answer: Answer;
  failures: Failure[];
  omittedUrls: string[];
  verification: {
    claim: number;
    origins: string[];
    distinctTexts: number;
    status: "corroborated" | "single-source" | "disputed";
  }[];
  grounding: "model-checked" | "no-claims";
  generatedAt: string;
}
export function candidates(
  hits: Hit[],
  r: Request,
): { urls: string[]; omittedUrls: string[] } {
  const allowed = new Set<string>();
  // User-supplied references also require actual reading; their text is never assumed.
  for (const raw of [...r.referenceUrls, ...hits.map((h) => h.url)]) {
    try {
      const url = canonical(raw);
      if (r.allowedOrigins.includes(new URL(url).origin)) allowed.add(url);
    } catch {
      /* Invalid search links are not executable. */
    }
  }
  return {
    urls: [...allowed].slice(0, r.maxPages),
    omittedUrls: [...allowed].slice(r.maxPages),
  };
}
export function pageEvidence(p: Page, queries: string[]): Evidence[] {
  const words = [
    ...new Set(
      queries
        .join(" ")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ];
  return p.blocks
    .map((s, index) => ({
      s,
      index,
      score: words.reduce((n, w) => n + Number(s.toLowerCase().includes(w)), 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map(({ s, index }) => ({
      id: digest(p.url + p.snapshot + index).slice(0, 24),
      pageKey: digest(p.requestedUrl),
      uri: p.url,
      title: p.title,
      hostname: new URL(p.url).hostname,
      fetchedAt: p.fetchedAt,
      snapshot: p.snapshot,
      startLine: index + 1,
      endLine: index + 1,
      text: s,
    }));
}
export function verification(
  a: Answer,
  evidence: Evidence[],
  s: Selection,
): Report["verification"] {
  return a.claims.map((c, claim) => {
    const cited = c.citations.map(
      (x) => evidence.find((e) => e.id === x.chunkId)!,
    );
    const origins = [...new Set(cited.map((e) => new URL(e.uri).origin))];
    const distinctTexts = new Set(
      cited.map((e) => digest(e.text.toLowerCase().replace(/\s+/g, " "))),
    ).size;
    return {
      claim,
      origins,
      distinctTexts,
      status: s.conflicts.some((conflict) =>
        conflict.sourceIds.some((id) =>
          c.citations.some((x) => x.chunkId === id),
        ),
      )
        ? "disputed"
        : origins.length >= 2 && distinctTexts >= 2
          ? "corroborated"
          : "single-source",
    };
  });
}
export function validateReport(v: unknown, r: Request): Report {
  const raw = object(v),
    report = v as Report;
  if (
    raw.requestId !== r.id ||
    raw.question !== r.question ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length > 8
  )
    throw new Error("Report identity or evidence invalid");
  const s = selection(report.selection, report.evidence);
  const a = answer(report.answer, report.evidence, s);
  const checks = verification(a, report.evidence, s);
  if (JSON.stringify(checks) !== JSON.stringify(report.verification))
    throw new Error("Verification record mismatch");
  if (
    r.crossCheck &&
    a.status === "answered" &&
    checks.some((c) => c.status !== "corroborated")
  )
    throw new Error("Independent origin corroboration required");
  if (
    report.evidence.some(
      (e) => !r.allowedOrigins.includes(new URL(canonical(e.uri)).origin),
    )
  )
    throw new Error("Citation origin denied");
  if (!Array.isArray(report.failures) || !Array.isArray(report.omittedUrls))
    throw new Error("Missing coverage record");
  if (a.claims.length && report.grounding !== "model-checked")
    throw new Error("Grounding verification required");
  return report;
}
