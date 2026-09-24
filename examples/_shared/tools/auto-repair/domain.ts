import { digest, identifier, object, text } from "../evidence.ts";
export const idOf = (v: unknown) => digest(JSON.stringify(v));
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
export type Kind = "code" | "sql" | "config";
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  question: string;
  kind: Kind;
  sourceDigest: string;
  maxModelCalls: number;
  maxExecutions: number;
  maxAttempts: number;
  deadlineSeconds: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (!["code", "sql", "config"].includes(String(r.kind)))
    throw new Error("Invalid task kind");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    question: text(r.question, 2000),
    kind: r.kind as Kind,
    sourceDigest: hash(r.sourceDigest),
    maxModelCalls: integer(r.maxModelCalls, 1, 12),
    maxExecutions: integer(r.maxExecutions, 1, 8),
    maxAttempts: integer(r.maxAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 3600),
  };
}
// This example accepts a bounded edit language, not arbitrary host programs.
export function content(kind: Kind, v: unknown): string {
  const s = text(v, 1000).trim();
  if (kind === "code") {
    if (s.length > 256) throw new Error("Expression too long");
    const tokens = s.match(
      /Math\.(?:round|floor|ceil)|amountCents|discountBps|\d+(?:\.\d+)?|[()+*/-]/g,
    );
    if (!tokens || tokens.join("") !== s.replace(/\s/g, ""))
      throw new Error("Only bounded arithmetic is allowed");
    if (/\/\*|\*\/|\/\/|\*\*/.test(s))
      throw new Error("Comments/exponentiation are not allowed");
    // Parentheses and syntax are checked by the actual JS execution; no strings,
    // assignments, imports, computed properties, loops or ambient API names exist.
  } else if (kind === "sql") {
    if (
      !/^SELECT\s+region\s*,\s*SUM\(\s*(?:cents|amount_cents)\s*\)\s+AS\s+totalCents\s+FROM\s+orders(?:\s+WHERE\s+status\s*=\s*'(?:paid|cancelled)')?\s+GROUP\s+BY\s+region\s+ORDER\s+BY\s+region\s*;?$/i.test(
        s,
      )
    )
      throw new Error("Only the documented single aggregate SELECT is allowed");
  } else {
    const c = object(JSON.parse(s));
    if (
      Object.keys(c).sort().join(",") !==
        "amountColumn,delimiter,statusFilter" ||
      ![",", ";", "\t"].includes(String(c.delimiter)) ||
      !["cents", "amount_cents"].includes(String(c.amountColumn)) ||
      !["paid", "cancelled", "all"].includes(String(c.statusFilter))
    )
      throw new Error("Invalid workflow configuration");
    return JSON.stringify(c);
  }
  return s;
}
export interface Revision {
  requestDigest: string;
  parentId: string | null;
  content: string;
  patch: Patch | null;
}
export interface Patch {
  baseRevisionId: string;
  executionId: string;
  diagnosis: string;
  changeSummary: string;
  content: string;
}
export interface Execution {
  revisionId: string;
  status: "passed" | "failed" | "blocked";
  errorCode: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  checks: { name: string; passed: boolean }[];
}
export type Run = Execution & { id: string };
export function patch(
  v: unknown,
  kind: Kind,
  base: string,
  failed: Run,
  previous: string,
): Patch {
  const p = object(v);
  if (
    Object.keys(p).sort().join(",") !==
      "baseRevisionId,changeSummary,content,diagnosis,executionId" ||
    p.baseRevisionId !== base ||
    p.executionId !== failed.id ||
    failed.revisionId !== base ||
    failed.status !== "failed"
  )
    throw new Error("Patch must address the current failed execution");
  const next = content(kind, p.content);
  if (next === previous) throw new Error("No change proposed");
  return {
    baseRevisionId: base,
    executionId: failed.id,
    diagnosis: text(p.diagnosis, 1500),
    changeSummary: text(p.changeSummary, 1000),
    content: next,
  };
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  runs: Run[];
  acceptedRevisionId: string | null;
  errors: string[];
  usage: { modelCalls: number; executions: number; startedAt: string };
  generatedAt: string;
}
