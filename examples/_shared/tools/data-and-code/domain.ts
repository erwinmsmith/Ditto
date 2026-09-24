import { createHash } from "node:crypto";
import type { JsonValue } from "@codesoul-co/ditto/contracts";
export const modes = [
  "query",
  "cleaning",
  "exploration",
  "calculation",
  "visualization",
  "interpretation",
  "code-search",
  "code-generation",
  "code-modification",
  "execution",
  "diagnosis",
  "code-review",
] as const;
export type Mode = (typeof modes)[number];
export interface Request {
  id: string;
  tenant: string;
  mode: Mode;
  instruction: string;
  sources: { path: string; sha256: string }[];
}
export interface File {
  path: string;
  sha256: string;
  content?: string;
}
export interface Material {
  files: File[];
  rows?: Record<string, string>[];
  schema?: string;
}
export interface Row {
  orderId: string;
  date: string;
  region: string;
  quantity: number;
  unitCents: number;
  status: string;
}
export interface Plan {
  tool: string;
  arguments: Record<string, JsonValue>;
}
export interface Outcome {
  tool: string;
  result: JsonValue;
  evidence: Record<string, JsonValue>;
  files: { file: string; sha256: string; bytes: number }[];
}
export interface Interpretation {
  summary: string;
  insights: {
    text: string;
    evidence: { pointer: string; value: JsonValue }[];
  }[];
  issues: {
    path: string;
    line: number;
    quote: string;
    severity: "low" | "medium" | "high";
    reason: string;
    fix: string;
  }[];
  limitations: string[];
}
export const digest = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v));
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected object");
  return v as Record<string, unknown>;
}
export function string(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 20000)
    throw new Error("Expected bounded text");
  return v;
}
export const isCode = (mode: Mode) =>
  [
    "code-search",
    "code-generation",
    "code-modification",
    "execution",
    "diagnosis",
    "code-review",
  ].includes(mode);
export const tools: Record<Mode, string> = {
  query: "data_query",
  cleaning: "data_clean",
  exploration: "data_profile",
  calculation: "data_calculate",
  visualization: "data_chart",
  interpretation: "data_metrics",
  "code-search": "repository_search",
  "code-generation": "code_patch",
  "code-modification": "code_patch",
  execution: "code_patch",
  diagnosis: "repository_tests",
  "code-review": "repository_tests",
};
export const codeRequirement =
  "Export function invoiceTotal(items) from invoice.mjs. Return the integer sum of quantity * unitCents. An empty array returns 0. Throw RangeError for negative, noninteger or unsafe integer quantity/unitCents, or unsafe line/total arithmetic. Do not mutate inputs. Preserve the function name. Only invoice.mjs may be changed; tests are controller-owned.";
export const requirements: Record<Mode, string> = {
  query:
    'Generate parameterized SQLite SELECT: paid sales grouped by region, sorted by region, returning exactly region, revenueCents (SUM(quantity*unitCents)), orders (COUNT(*)). Use status = ? and parameters ["paid"].',
  cleaning:
    "Write a JavaScript function BODY receiving input.rows (raw CSV objects). Return the cleaned Row[] only, preserving original order. Trim text, normalize region to initial capital and status to lower case, convert quantity/unitCents decimal strings to integers, replace / with - in ISO dates. Missing region becomes Unknown. Drop missing orderId, invalid date (including calendar rollover), invalid/missing/negative/noninteger numbers, quantity>1000, unitCents>100000000, status outside paid/pending/refunded. Remove duplicate orderId, keeping first valid row. Row fields: orderId,date,region,quantity,unitCents,status. Do not call external packages.",
  exploration:
    "Profile raw fields, missing counts, clean numeric distributions and Pearson correlation of quantity with gross line value. Do not imply causation.",
  calculation:
    "Write a JavaScript function BODY receiving input.rows (clean Row[]). Return exactly {paidOrders,totalRevenueCents,averageOrderCents,byRegion:[{region,revenueCents,orders}]}. Include only status paid; multiply quantity*unitCents; round average cents to nearest integer, zero if empty; sort byRegion by region.",
  visualization:
    "Choose a grouped bar chart with x=region, y=revenueCents, group=status. Values are gross order totals in cents for paid/pending/refunded; display USD, not net revenue. No uncertainty or significance annotations.",
  interpretation:
    "Explain paid order counts, revenue, rounded average order value and regional differences from actual computed metrics. Use supplied numeric evidence; do not invent reasons or business forecasts.",
  "code-search":
    "Search the supplied repository for invoiceTotal with a literal query. Cite exact files and line numbers from the search results.",
  "code-generation": codeRequirement,
  "code-modification": codeRequirement,
  execution: codeRequirement,
  diagnosis:
    "Run the supplied tests on the repository, read actual failure output and diagnose invoiceTotal against this specification: " +
    codeRequirement,
  "code-review":
    "Review invoice.mjs for logical correctness and input/overflow risks against this specification, using actual tests as supporting evidence: " +
    codeRequirement,
};
export function request(r: Request): Request {
  if (
    !/^[\w-]{1,80}$/.test(r.id) ||
    !/^[\w-]{1,80}$/.test(r.tenant) ||
    !modes.includes(r.mode)
  )
    throw new Error("Invalid task identity");
  string(r.instruction);
  const expected = isCode(r.mode)
    ? ["invoice.mjs", "invoice.test.mjs", "README.md"]
    : ["sales.csv", "business.sqlite"];
  if (
    r.sources.length !== expected.length ||
    new Set(r.sources.map((s) => s.path)).size !== expected.length
  )
    throw new Error("Invalid source inventory");
  for (const s of r.sources)
    if (!expected.includes(s.path) || !/^[a-f0-9]{64}$/.test(s.sha256))
      throw new Error("Invalid source identity");
  return structuredClone(r);
}
export function material(v: unknown, r: Request): Material {
  const m = object(v);
  if (!Array.isArray(m.files) || m.files.length !== r.sources.length)
    throw new Error("Material inventory mismatch");
  for (const expected of r.sources) {
    const f = m.files.find((f) => object(f).path === expected.path);
    if (!f || object(f).sha256 !== expected.sha256)
      throw new Error("Material checksum identity mismatch");
    const content = object(f).content;
    if (
      content !== undefined &&
      (typeof content !== "string" || digest(content) !== expected.sha256)
    )
      throw new Error("Material content checksum mismatch");
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 48000)
    throw new Error("Material exceeds context budget");
  return v as Material;
}
export function plan(v: unknown, r: Request, m: Material): Plan {
  const p = object(v),
    a = object(p.arguments);
  if (p.tool !== tools[r.mode])
    throw new Error("Tool not allowed for this task");
  if (p.tool === "data_query") {
    string(a.sql);
    if (
      !Array.isArray(a.parameters) ||
      JSON.stringify(a.parameters) !== '["paid"]'
    )
      throw new Error("Expected paid parameter");
  } else if (p.tool === "data_clean" || p.tool === "data_calculate")
    string(a.code);
  else if (p.tool === "code_patch") {
    if (
      a.path !== "invoice.mjs" ||
      a.expectedSha256 !== m.files.find((f) => f.path === "invoice.mjs")?.sha256
    )
      throw new Error("Patch target or base checksum mismatch");
    string(a.content);
  } else if (p.tool === "repository_search") {
    if (string(a.query).length > 100) throw new Error("Query too long");
  } else if (p.tool === "data_chart") {
    if (a.x !== "region" || a.y !== "revenueCents" || a.group !== "status")
      throw new Error("Unsupported chart encoding");
  } else if (Object.keys(a).length)
    throw new Error("Unexpected tool arguments");
  return v as Plan;
}
export function clean(rows: Record<string, string>[]) {
  const result: Row[] = [],
    issues: { row: number; reason: string }[] = [],
    seen = new Set<string>();
  rows.forEach((r, i) => {
    const id = (r.orderId ?? "").trim(),
      date = (r.date ?? "").trim().replaceAll("/", "-"),
      region = (r.region ?? "").trim().toLowerCase(),
      status = (r.status ?? "").trim().toLowerCase(),
      qs = (r.quantity ?? "").trim(),
      us = (r.unitCents ?? "").trim(),
      quantity = Number(qs),
      unitCents = Number(us);
    let reason = "";
    if (!id) reason = "missing-order-id";
    else if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      reason = "invalid-date";
    else if (
      !/^\d+$/.test(qs) ||
      !/^\d+$/.test(us) ||
      !Number.isSafeInteger(quantity) ||
      !Number.isSafeInteger(unitCents) ||
      quantity > 1000 ||
      unitCents > 100000000
    )
      reason = "invalid-number";
    else if (!["paid", "pending", "refunded"].includes(status))
      reason = "invalid-status";
    else if (seen.has(id)) reason = "duplicate-order-id";
    if (reason) {
      issues.push({ row: i + 2, reason });
      return;
    }
    seen.add(id);
    result.push({
      orderId: id,
      date,
      region: region ? region[0]!.toUpperCase() + region.slice(1) : "Unknown",
      quantity,
      unitCents,
      status,
    });
  });
  return { rows: result, issues };
}
export function metrics(rows: Row[]) {
  const paid = rows.filter((r) => r.status === "paid"),
    regions = [...new Set(paid.map((r) => r.region))].sort(),
    byRegion = regions.map((region) => {
      const rows = paid.filter((r) => r.region === region);
      return {
        region,
        revenueCents: rows.reduce((n, r) => n + r.quantity * r.unitCents, 0),
        orders: rows.length,
      };
    }),
    totalRevenueCents = byRegion.reduce((n, r) => n + r.revenueCents, 0);
  return {
    paidOrders: paid.length,
    totalRevenueCents,
    averageOrderCents: paid.length
      ? Math.round(totalRevenueCents / paid.length)
      : 0,
    byRegion,
  };
}
export function profile(raw: Record<string, string>[], rows: Row[]) {
  const distribution = (values: number[]) => {
    const n = values.length,
      mean = n ? values.reduce((n, v) => n + v, 0) / n : null;
    return {
      count: n,
      min: n ? Math.min(...values) : null,
      max: n ? Math.max(...values) : null,
      mean,
    };
  };
  const x = rows.map((r) => r.quantity),
    y = rows.map((r) => r.quantity * r.unitCents),
    xm = distribution(x).mean ?? 0,
    ym = distribution(y).mean ?? 0,
    numerator = x.reduce((s, v, i) => s + (v - xm) * (y[i]! - ym), 0),
    denominator = Math.sqrt(
      x.reduce((s, v) => s + (v - xm) ** 2, 0) *
        y.reduce((s, v) => s + (v - ym) ** 2, 0),
    );
  return {
    rawRows: raw.length,
    cleanRows: rows.length,
    columns: Object.keys(raw[0] ?? {}).map((name) => ({
      name,
      missing: raw.filter((r) => !(r[name] ?? "").trim()).length,
    })),
    quantity: distribution(x),
    lineValueCents: distribution(y),
    statusCounts: Object.fromEntries(
      ["paid", "pending", "refunded"].map((s) => [
        s,
        rows.filter((r) => r.status === s).length,
      ]),
    ),
    pearsonQuantityLineValue: denominator
      ? Number((numerator / denominator).toFixed(6))
      : null,
  };
}
export function pointer(value: unknown, path: string): unknown {
  if (!path.startsWith("/")) throw new Error("Evidence needs JSON pointer");
  return path
    .slice(1)
    .split("/")
    .reduce((v: unknown, key) => {
      if (!v || typeof v !== "object")
        throw new Error("Unknown result pointer");
      const k = key.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!Object.hasOwn(v, k)) throw new Error("Unknown result pointer");
      return (v as Record<string, unknown>)[k];
    }, value);
}
/** Small scalar facts available for exact result citations; raw logs stay in artifacts. */
export function evidenceCatalog(result: unknown) {
  const entries: { pointer: string; value: JsonValue }[] = [];
  function visit(value: unknown, path: string) {
    if (entries.length >= 200) return;
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 200)
    ) {
      entries.push({ pointer: path, value: json(value) });
      return;
    }
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        visit(
          child,
          path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
        );
  }
  visit(result, "");
  return entries.filter((e) => e.pointer);
}
export function testSummary(stdout: string) {
  const count = (name: string) =>
    Number(new RegExp("^# " + name + " (\\d+)$", "m").exec(stdout)?.[1] ?? -1);
  return {
    tests: count("tests"),
    passed: count("pass"),
    failed: count("fail"),
    cases: [...stdout.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map((m) => ({
      name: m[2]!,
      passed: m[1] === "ok",
    })),
  };
}
export function interpretation(
  v: unknown,
  r: Request,
  m: Material,
  o: Outcome,
): Interpretation {
  const a = object(v);
  string(a.summary);
  if (
    !Array.isArray(a.insights) ||
    !a.insights.length ||
    a.insights.length > 16 ||
    !Array.isArray(a.issues) ||
    !Array.isArray(a.limitations)
  )
    throw new Error("Invalid interpretation");
  for (const raw of a.insights) {
    const i = object(raw);
    string(i.text);
    if (!Array.isArray(i.evidence) || !i.evidence.length)
      throw new Error("Evidence required");
    for (const raw of i.evidence) {
      const e = object(raw);
      if (
        !evidenceCatalog(o.result).some(
          (c) =>
            c.pointer === e.pointer &&
            JSON.stringify(c.value) === JSON.stringify(e.value),
        )
      )
        throw new Error("Result evidence pointer/value outside catalog");
      if (
        JSON.stringify(pointer(o.result, string(e.pointer))) !==
        JSON.stringify(e.value)
      )
        throw new Error("Result evidence mismatch");
    }
  }
  for (const raw of a.issues) {
    const i = object(raw),
      f = m.files.find((f) => f.path === i.path);
    if (
      !f?.content ||
      !Number.isInteger(i.line) ||
      Number(i.line) < 1 ||
      f.content.split("\n")[Number(i.line) - 1]?.trim() !== i.quote
    )
      throw new Error("Code issue location mismatch");
    if (!["low", "medium", "high"].includes(String(i.severity)))
      throw new Error("Invalid severity");
    string(i.reason);
    string(i.fix);
  }
  if (!["diagnosis", "code-review"].includes(r.mode) && a.issues.length)
    throw new Error("Unexpected review issues");
  if (["diagnosis", "code-review"].includes(r.mode) && !a.issues.length)
    throw new Error("Expected diagnosis for failing tests");
  a.limitations.forEach(string);
  return v as Interpretation;
}
