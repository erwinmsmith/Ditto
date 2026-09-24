import { createHash } from "node:crypto";
import type { JsonObject } from "@ditto/core/contracts";
export const modes = ["aggregate", "deduplicate", "conflicts", "fact-check", "extract", "convert", "compare"] as const;
export type Mode = typeof modes[number];
export type Format = "text" | "web" | "csv" | "xlsx" | "pdf" | "image" | "memory" | "external";
export type Origin = "document" | "web" | "knowledge-internal" | "knowledge-external";
export interface Source { id: string; format: Format; origin: Origin; authority: "reference" | "claim"; period: string; locator: string }
export interface Request { id: string; tenant: string; mode: Mode; question: string; period: string; subjects: string[]; sources: Source[]; allowedOrigins: string[] }
export interface Block { id: string; sourceId: string; text: string; location: string; snapshot: string }
export interface Material { blocks: Block[]; sources: { id: string; snapshot: string; engine: string; uri: string }[] }
export const fieldUnits = { retention_days: { day: 1, days: 1, week: 7, weeks: 7 }, storage_gb: { GB: 1, TB: 1000 }, support_hours: { hour: 1, hours: 1 } } as const;
export type Field = keyof typeof fieldUnits;
export const fields = Object.keys(fieldUnits) as Field[];
const units: Record<Field, string> = { retention_days: "days", storage_gb: "GB", support_hours: "hours" };
const hints: Record<Field, RegExp> = { retention_days: /retention|keep|keeps|retain|retained/i, storage_gb: /storage|capacity/i, support_hours: /support|response/i };
export interface Claim { id: string; blockId: string; subject: string; field: Field; value: number; unit: string; quote: string; sourceId: string; period: string; origin: Origin; authority: Source["authority"] }
export interface Group { id: string; subject: string; field: Field; period: string; value: number; unit: string; claims: string[]; sources: string[]; verification: "supported" | "refuted" | "unverified" | "disputed"; referenceGroups: string[] }
export interface Report {
  requestId: string; focus: Mode; question: string; period: string;
  material: Material; claims: Claim[]; unresolved: { blockId: string; reason: string }[]; groups: Group[];
  duplicates: { groupId: string; removed: number; sources: string[] }[];
  conflicts: { subject: string; field: Field; period: string; groups: string[] }[];
  comparison: { subject: string; field: Field; unit: string; value: number | null; status: "known" | "unknown" | "disputed"; groups: string[] }[];
  differences: { left: string; right: string; field: Field; unit: string; delta: number | null }[];
}
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export function text(value: unknown, max = 1000): string { if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error("Invalid text"); return value.trim(); }
export function request(value: unknown): Request {
  const v = object(value); if (!modes.includes(v.mode as Mode)) throw new Error("Invalid analysis mode");
  const identity = (value: unknown) => { const out = text(value, 64); if (!/^[A-Za-z0-9_-]+$/.test(out)) throw new Error("Invalid identity"); return out; };
  const period = (value: unknown) => { const out = text(value, 20); if (!/^\d{4}-Q[1-4]$/.test(out)) throw new Error("Invalid period"); return out; };
  if (!Array.isArray(v.subjects) || v.subjects.length < 2 || v.subjects.length > 8 || !Array.isArray(v.sources) || !v.sources.length || v.sources.length > 12 || !Array.isArray(v.allowedOrigins)) throw new Error("Invalid analysis request");
  const tenant = identity(v.tenant), subjects = v.subjects.map(identity), origins = v.allowedOrigins.map(x => { const u = new URL(text(x, 256)); if (u.origin !== x || !(u.protocol === "https:" || u.protocol === "http:" && u.hostname === "127.0.0.1")) throw new Error("Invalid origin"); return u.origin; });
  if (new Set(subjects).size !== subjects.length) throw new Error("Duplicate subject");
  const sources = v.sources.map(value => {
    const s = object(value), format = s.format as Format; if (!["text", "web", "csv", "xlsx", "pdf", "image", "memory", "external"].includes(format) || !["reference", "claim"].includes(String(s.authority))) throw new Error("Invalid source");
    const origin: Origin = format === "memory" ? "knowledge-internal" : format === "external" ? "knowledge-external" : format === "web" ? "web" : "document";
    if (s.origin !== origin) throw new Error("Source origin does not match transport");
    const locator = text(s.locator, 2048);
    if (format === "web") { const u = new URL(locator); if (u.username || u.password || !origins.includes(u.origin)) throw new Error("Unapproved page origin"); }
    else if (format === "memory") { if (!locator.startsWith(`knowledge:${tenant}:`) || !/^[a-zA-Z0-9:_-]+$/.test(locator)) throw new Error("Internal knowledge key outside tenant"); }
    else if (!/^[A-Za-z0-9_.-]+$/.test(locator) || locator.includes("..")) throw new Error("Invalid local source name");
    return { id: identity(s.id), format, origin, authority: s.authority as Source["authority"], period: period(s.period), locator };
  });
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error("Duplicate source ID");
  return { id: identity(v.id), tenant, mode: v.mode as Mode, question: text(v.question), period: period(v.period), subjects, sources, allowedOrigins: origins };
}
export function compileReport(r: Request, material: Material, proposal: unknown): Report {
  const p = object(proposal); if (!Array.isArray(p.claims) || !Array.isArray(p.unresolved)) throw new Error("Invalid extraction schema");
  const covered = new Set<string>();
  const blockFor = (value: unknown) => { const id = text(value, 128), block = material.blocks.find(b => b.id === id); if (!block || covered.has(id)) throw new Error("Unknown or duplicate block"); covered.add(id); return block; };
  const claims = p.claims.map(value => {
    const c = object(value), block = blockFor(c.blockId), source = r.sources.find(s => s.id === block.sourceId)!;
    const subject = text(c.subject, 64), field = c.field as Field, unit = text(c.unit, 16), quote = text(c.quote, 1200);
    if (!r.subjects.includes(subject) || !fields.includes(field) || typeof c.value !== "number" || !Number.isFinite(c.value) || c.value < 0 || c.value > 1000000) throw new Error("Invalid extracted value");
    const allowed = fieldUnits[field] as Record<string, number>, factor = Object.hasOwn(allowed, unit) ? allowed[unit] : undefined;
    const escaped = String(c.value).replaceAll(".", "\\.");
    if (!factor || !block.text.includes(quote) || !new RegExp(`\\b${subject}\\b`, "i").test(quote) || !hints[field].test(quote) || !new RegExp(`(?<![\\d.])${escaped}\\s+${unit}\\b`).test(quote) || /\b(?:not|never|no longer)\b/i.test(quote)) throw new Error("Unsupported extraction citation");
    return { id: `claim-${block.id}`, blockId: block.id, subject, field, value: c.value * factor, unit: units[field], quote, sourceId: source.id, period: source.period, origin: source.origin, authority: source.authority };
  });
  const unresolved = p.unresolved.map(value => { const item = object(value), block = blockFor(item.blockId); return { blockId: block.id, reason: text(item.reason, 256) }; });
  if (covered.size !== material.blocks.length) throw new Error("Extraction omitted a source block");
  const grouped = new Map<string, Group>();
  for (const claim of claims) {
    const key = JSON.stringify([claim.subject, claim.field, claim.period, claim.value]); let group = grouped.get(key);
    if (!group) { group = { id: `fact-${digest(key).slice(0, 20)}`, subject: claim.subject, field: claim.field, period: claim.period, value: claim.value, unit: claim.unit, claims: [], sources: [], verification: "unverified", referenceGroups: [] }; grouped.set(key, group); }
    group.claims.push(claim.id); if (!group.sources.includes(claim.sourceId)) group.sources.push(claim.sourceId);
  }
  const groups = [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
  const identity = (g: Group) => JSON.stringify([g.subject, g.field, g.period]);
  for (const group of groups) {
    const references = groups.filter(g => identity(g) === identity(group) && g.claims.some(id => claims.find(c => c.id === id)!.authority === "reference"));
    group.referenceGroups = references.map(g => g.id);
    group.verification = references.length > 1 ? "disputed" : references.length === 0 ? "unverified" : references[0]!.value === group.value ? "supported" : "refuted";
  }
  const keys = [...new Set(groups.map(identity))];
  const conflicts = keys.flatMap(key => { const variants = groups.filter(g => identity(g) === key); return variants.length > 1 ? [{ subject: variants[0]!.subject, field: variants[0]!.field, period: variants[0]!.period, groups: variants.map(g => g.id) }] : []; });
  const comparison: Report["comparison"] = r.subjects.flatMap(subject => fields.map(field => {
    const relevant = groups.filter(g => g.subject === subject && g.field === field && g.period === r.period), supported = relevant.filter(g => g.verification === "supported");
    return { subject, field, unit: units[field], value: supported.length === 1 ? supported[0]!.value : null, status: relevant.some(g => g.verification === "disputed") ? "disputed" as const : supported.length === 1 ? "known" as const : "unknown" as const, groups: relevant.map(g => g.id) };
  }));
  const differences: Report["differences"] = [];
  for (let i = 0; i < r.subjects.length; i++) for (const right of r.subjects.slice(i + 1)) for (const field of fields) {
    const left = r.subjects[i]!, a = comparison.find(v => v.subject === left && v.field === field)!, b = comparison.find(v => v.subject === right && v.field === field)!;
    differences.push({ left, right, field, unit: units[field], delta: a.value !== null && b.value !== null ? b.value - a.value : null });
  }
  return { requestId: r.id, focus: r.mode, question: r.question, period: r.period, material, claims, unresolved, groups, duplicates: groups.filter(g => g.claims.length > 1).map(g => ({ groupId: g.id, removed: g.claims.length - 1, sources: g.sources })), conflicts, comparison, differences };
}
export const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
export function renderReport(report: Report) {
  const columns = ["subject", "field", "period", "value", "unit", "verification", "sources"];
  const rows = report.groups.map(g => [g.subject, g.field, g.period, g.value, g.unit, g.verification, g.sources.join(";")]);
  const csv = [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const markdown = [`# Information analysis`, "", report.question, "", `Focus: ${report.focus}; comparison period: ${report.period}`, "", `Claims: ${report.claims.length}; unique facts: ${report.groups.length}; conflicts: ${report.conflicts.length}; unresolved blocks: ${report.unresolved.length}`, "", "| Object | Field | Value | Unit | Status |", "| --- | --- | ---: | --- | --- |", ...report.comparison.map(v => `| ${v.subject} | ${v.field} | ${v.value ?? "unknown"} | ${v.unit} | ${v.status} |`), "", "## Source excerpts", "", ...report.claims.flatMap(c => { const b = report.material.blocks.find(b => b.id === c.blockId)!; return [`> ${c.quote}`, "", `${c.sourceId} (${c.origin}, ${c.authority}, ${c.period}), ${b.location}; snapshot ${b.snapshot}`, ""]; }), "## Conflicts", "", ...report.conflicts.map(c => `${c.subject} / ${c.field} / ${c.period}: ${c.groups.join(", ")}`), "", "## Unresolved input", "", ...report.unresolved.map(u => `${u.blockId}: ${u.reason}`)].join("\n") + "\n";
  return { csv, markdown };
}
