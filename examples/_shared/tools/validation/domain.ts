import { createHash } from "node:crypto";
import type { JsonValue } from "@codesoul-co/ditto/contracts";
export const modes = [
  "schema",
  "evaluate",
  "consistency",
  "permissions",
  "risk",
  "policy",
  "input-safety",
  "sensitive-data",
  "redaction",
] as const;
export type Mode = (typeof modes)[number];
export interface Request {
  id: string;
  tenant: string;
  mode: Mode;
  sourceHash: string;
}
export interface Finding {
  path: string;
  kind: string;
}
export interface Material {
  document: Record<string, unknown>;
  findings: Finding[];
  checks: { code: string; passed: boolean; paths: string[] }[];
  sourceHash: string;
}
export interface Assessment {
  summary: string;
  dimensions: {
    name: "completeness" | "relevance" | "clarity";
    score: number;
    reason: string;
    evidence: { path: string; quote: string }[];
  }[];
  limitations: string[];
}
export interface Policy {
  revision: number;
  actor: string;
  tenant: string;
  role: "publisher" | "reader";
  targetTenant: string;
  target: string;
  affected: number;
  reversible: boolean;
  enabled: boolean;
  maxAffected: number;
}
export interface Receipt {
  status: "published" | "denied" | "confirmation-required";
  reasons: string[];
  policyRevision: number;
  payloadHash: string;
  effectId: string | null;
}
export const digest = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const json = (v: unknown): JsonValue =>
  JSON.parse(JSON.stringify(v)) as JsonValue;
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected object");
  return v as Record<string, unknown>;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (
    Object.keys(r).sort().join() !== "id,mode,sourceHash,tenant" ||
    ![r.id, r.tenant].every(
      (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(x),
    ) ||
    !modes.includes(r.mode as Mode) ||
    typeof r.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.sourceHash)
  )
    throw new Error("Invalid validation request");
  return r as unknown as Request;
}
const patterns: [string, RegExp][] = [
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ["phone", /\b1[3-9]\d{9}\b/g],
  ["token", /\b(?:sk|token|secret)[-_][A-Za-z0-9_-]{8,}\b/gi],
];
const sensitiveKey =
  /^(?:password|api[_-]?key|access[_-]?token|secret|authorization|phone|email|name|address|nationalId)$/i;
export function sanitize(value: unknown): {
  value: unknown;
  findings: Finding[];
} {
  const findings: Finding[] = [];
  function walk(v: unknown, path: string, depth: number): unknown {
    if (depth > 12) throw new Error("Input nesting limit exceeded");
    if (typeof v === "string") {
      let safe = v;
      for (const [kind, pattern] of patterns)
        safe = safe.replace(pattern, () => {
          findings.push({ path, kind });
          return `[REDACTED:${kind}]`;
        });
      return safe;
    }
    if (Array.isArray(v))
      return v.map((x, i) => walk(x, `${path}/${i}`, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          // Paths are stable schema fields or array indices, never arbitrary untrusted key text.
          const p = path + "/" + k.replaceAll("~", "~0").replaceAll("/", "~1");
          if (sensitiveKey.test(k)) {
            findings.push({ path: p, kind: "sensitive-field" });
            return [k, "[REDACTED]"];
          }
          return [k, walk(x, p, depth + 1)];
        }),
      );
    return v;
  }
  return { value: walk(value, "", 0), findings };
}
export function material(raw: unknown, sourceHash: string): Material {
  const d = object(raw);
  // A fixed ingress schema prevents secrets hidden in arbitrary object keys from becoming trace paths.
  const allowed = ["title", "summary", "actions", "claims", "contact", "note"];
  if (Object.keys(d).some((k) => !allowed.includes(k)))
    throw new Error("Unsupported source field");
  for (const key of ["title", "summary", "note"])
    if (
      d[key] !== undefined &&
      (typeof d[key] !== "string" || (d[key] as string).length > 4000)
    )
      throw new Error("Invalid text field");
  if (
    !Array.isArray(d.actions) ||
    d.actions.length > 20 ||
    d.actions.some((x) => typeof x !== "string" || x.length > 1000)
  )
    throw new Error("Invalid actions");
  if (!Array.isArray(d.claims) || d.claims.length > 20)
    throw new Error("Invalid claims");
  for (const c of d.claims) {
    const x = object(c);
    if (
      Object.keys(x).sort().join() !== "metric,source,value" ||
      ![x.metric, x.source].every(
        (v) => typeof v === "string" && v.length <= 100,
      ) ||
      typeof x.value !== "number" ||
      !Number.isFinite(x.value)
    )
      throw new Error("Invalid claim");
  }
  if (d.contact !== undefined) {
    const c = object(d.contact);
    if (
      Object.keys(c).some(
        (k) => !["name", "email", "phone", "apiKey", "address"].includes(k),
      ) ||
      Object.values(c).some((v) => typeof v !== "string" || v.length > 500)
    )
      throw new Error("Invalid contact");
  }
  const cleaned = sanitize(d),
    document = object(cleaned.value);
  const injectionPattern =
    /ignore\s+(?:all\s+)?(?:previous|system)\s+instructions|reveal\s+(?:the\s+)?(?:secret|system prompt)|忽略.{0,8}(?:指令|规则)|泄露.{0,8}(?:密钥|密码)/i;
  const injectionPaths = catalog({
    document,
    findings: [],
    checks: [],
    sourceHash,
  })
    .filter((e) => injectionPattern.test(e.quote.normalize("NFKC")))
    .map((e) => e.path);
  const claims = d.claims as {
    metric: string;
    value: number;
    source: string;
  }[];
  const conflicts = claims.flatMap((c, i) =>
    claims.some((b, j) => j < i && b.metric === c.metric && b.value !== c.value)
      ? [`/claims/${i}/value`]
      : [],
  );
  return {
    document,
    findings: cleaned.findings,
    sourceHash,
    checks: [
      {
        code: "requirements",
        passed:
          typeof d.title === "string" &&
          d.title.trim().length > 0 &&
          typeof d.summary === "string" &&
          d.summary.trim().length >= 40 &&
          d.actions.length > 0 &&
          claims.length > 0,
        paths: ["/title", "/summary", "/actions", "/claims"],
      },
      { code: "consistency", passed: conflicts.length === 0, paths: conflicts },
      {
        code: "input-safety",
        passed: injectionPaths.length === 0,
        paths: injectionPaths,
      },
    ],
  };
}
export function catalog(m: Material): { path: string; quote: string }[] {
  const out: { path: string; quote: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string" && v.length) out.push({ path, quote: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
    else if (v && typeof v === "object")
      Object.entries(v).forEach(([k, x]) => walk(x, `${path}/${k}`));
  };
  walk(m.document, "");
  return out;
}
export function assessment(v: unknown, m: Material): Assessment {
  const a = object(v),
    entries = catalog(m);
  if (
    typeof a.summary !== "string" ||
    !a.summary.trim() ||
    a.summary.length > 1500 ||
    !Array.isArray(a.limitations) ||
    a.limitations.length === 0 ||
    a.limitations.length > 5 ||
    a.limitations.some((s) => typeof s !== "string" || s.length > 500) ||
    !Array.isArray(a.dimensions) ||
    a.dimensions.length !== 3
  )
    throw new Error("Invalid assessment");
  const seen = new Set<string>();
  for (const raw of a.dimensions) {
    const d = object(raw);
    if (
      typeof d.name !== "string" ||
      !["completeness", "relevance", "clarity"].includes(d.name) ||
      seen.has(String(d.name)) ||
      typeof d.score !== "number" ||
      !Number.isInteger(d.score) ||
      d.score < 0 ||
      d.score > 4 ||
      typeof d.reason !== "string" ||
      !d.reason.trim() ||
      d.reason.length > 1000 ||
      !Array.isArray(d.evidence) ||
      !d.evidence.length ||
      d.evidence.length > 4
    )
      throw new Error("Invalid rubric score");
    seen.add(String(d.name));
    for (const raw of d.evidence) {
      const e = object(raw);
      if (!entries.some((x) => x.path === e.path && x.quote === e.quote))
        throw new Error("Unsupported evaluation evidence");
    }
  }
  // Reject extra model fields so hidden payloads cannot be propagated into Memory or the sink.
  if (
    Object.keys(a).sort().join() !== "dimensions,limitations,summary" ||
    a.dimensions.some(
      (d) =>
        Object.keys(object(d)).sort().join() !== "evidence,name,reason,score" ||
        (object(d).evidence as unknown[]).some(
          (e) => Object.keys(object(e)).sort().join() !== "path,quote",
        ),
    )
  )
    throw new Error("Unexpected assessment field");
  if (sanitize(JSON.stringify(a)).value !== JSON.stringify(a))
    throw new Error("Sensitive model output rejected");
  return a as unknown as Assessment;
}
export function policy(v: unknown): Policy {
  const p = object(v);
  if (
    Object.keys(p).sort().join() !==
      "actor,affected,enabled,maxAffected,reversible,revision,role,target,targetTenant,tenant" ||
    ![p.actor, p.tenant, p.targetTenant, p.target].every(
      (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(x),
    ) ||
    typeof p.role !== "string" ||
    !["publisher", "reader"].includes(p.role) ||
    ![p.affected, p.maxAffected, p.revision].every(
      (x) => Number.isSafeInteger(x) && Number(x) > 0,
    ) ||
    typeof p.enabled !== "boolean" ||
    typeof p.reversible !== "boolean"
  )
    throw new Error("Invalid trusted policy");
  return p as unknown as Policy;
}
export function gate(
  r: Request,
  m: Material,
  a: Assessment,
  p: Policy,
  approved: boolean,
): Omit<Receipt, "payloadHash" | "effectId"> {
  policy(p);
  assessment(a, m);
  const reasons = m.checks.filter((c) => !c.passed).map((c) => c.code);
  if (
    p.tenant !== r.tenant ||
    p.targetTenant !== r.tenant ||
    p.role !== "publisher"
  )
    reasons.push("permission-denied");
  if (!p.enabled || p.affected > p.maxAffected) reasons.push("policy-denied");
  if (a.dimensions.some((d) => d.score < 2)) reasons.push("quality-threshold");
  return {
    status: reasons.length
      ? "denied"
      : (!p.reversible || p.affected > 1) && !approved
        ? "confirmation-required"
        : "published",
    reasons: reasons.length
      ? reasons
      : (!p.reversible || p.affected > 1) && !approved
        ? ["risk-approval-required"]
        : [],
    policyRevision: p.revision,
  };
}
