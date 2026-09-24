import { createHash } from "node:crypto";
import type { Context, ContextItem, JsonValue } from "@codesoul-co/ditto/contracts";
export const modes = ["load", "select", "assemble", "compress", "update"] as const;
export type Mode = typeof modes[number];
export interface Request { id: string; tenant: string; mode: Mode; goal: string; searchUrl: string }
export interface Brief { releaseCode: string; region: string; rolloutPercent: number; owner: string; budget: number; citations: string[] }
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export function request(value: unknown): Request {
  const r = object(value);
  for (const key of ["id", "tenant"]) if (typeof r[key] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(r[key])) throw new Error(`Invalid ${key}`);
  if (!modes.includes(r.mode as Mode) || typeof r.goal !== "string" || !r.goal.trim() || r.goal.length > 1000 || typeof r.searchUrl !== "string") throw new Error("Invalid context request");
  const url = new URL(r.searchUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid search URL");
  return { id: r.id as string, tenant: r.tenant as string, mode: r.mode as Mode, goal: r.goal, searchUrl: url.href };
}
export function document(value: unknown) {
  const d = object(value); if (typeof d.releaseCode !== "string" || !/^[A-Z0-9-]{1,40}$/.test(d.releaseCode) || typeof d.region !== "string" || !/^[a-z-]{2,30}$/.test(d.region) || !Number.isInteger(d.rolloutPercent) || Number(d.rolloutPercent) < 1 || Number(d.rolloutPercent) > 100) throw new Error("Invalid release document");
  return { releaseCode: d.releaseCode, region: d.region, rolloutPercent: Number(d.rolloutPercent) };
}
export function history(value: unknown): ContextItem[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 100) throw new Error("Invalid history");
  return value.map((v, i) => { const h = object(v); if (typeof h.text !== "string" || h.text.length > 3000) throw new Error("Invalid history text"); return { id: `history-${i}`, content: h.text, source: { uri: `memory:conversation/turn/${i}` }, metadata: { role: "user", origin: "history", ...(i < 2 ? { priority: 10 } : {}) } }; });
}
export function essentialHistory(items: readonly ContextItem[]) {
  const owner = items.find(i => i.id === "history-0"), budget = items.find(i => i.id === "history-1");
  const ownerMatch = typeof owner?.content === "string" ? /^Approved release owner: ([A-Za-z0-9-]+)\.$/.exec(owner.content) : null;
  const budgetMatch = typeof budget?.content === "string" ? /^Approved release budget: (\d+) USD\.$/.exec(budget.content) : null;
  if (!ownerMatch || !budgetMatch) throw new Error("Missing approved conversation decisions");
  return { owner: ownerMatch[1]!, budget: Number(budgetMatch[1]), evidence: [owner!, budget!] };
}
export function validateSummary(value: unknown, items: readonly ContextItem[]) {
  const s = object(value), expected = essentialHistory(items);
  if (s.owner !== expected.owner || s.budget !== expected.budget || !Array.isArray(s.evidence) || s.evidence.length !== 2) throw new Error("Summary lost approved decisions");
  for (const item of expected.evidence) if (!s.evidence.some(v => { const e = object(v); return e.id === item.id && e.quote === item.content; })) throw new Error("Summary contains unsupported evidence");
  return { owner: expected.owner, budget: expected.budget, evidence: expected.evidence.map(i => ({ id: i.id, quote: i.content, source: i.source! })) };
}
export function validateBrief(value: unknown, context: Context): Brief {
  const b = object(value), doc = document(context.items.find(i => i.id === "document")?.content);
  const summary = context.items.find(i => i.id === "summary"), decisions = summary ? object(summary.content) : essentialHistory(context.items);
  const external = context.items.find(i => i.id === "search"), region = external ? object(external.content).region : doc.region;
  for (const [key, expected] of Object.entries({ ...doc, region, owner: decisions.owner, budget: decisions.budget })) if (b[key] !== expected) throw new Error(`Unsupported brief field: ${key}`);
  const required = ["document", ...(summary ? ["summary"] : ["history-0", "history-1"]), ...(external ? ["search"] : [])];
  const citations = b.citations;
  if (!Array.isArray(citations) || required.some(id => !citations.includes(id)) || citations.some(id => typeof id !== "string" || !required.includes(id))) throw new Error("Invalid brief citations");
  return { ...doc, region: String(region), owner: String(decisions.owner), budget: Number(decisions.budget), citations: [...new Set(b.citations as string[])] };
}
export function requireInstructions(context: Context) { for (const id of ["instructions", "goal"]) if (!context.items.some(i => i.id === id)) throw new Error(`Context budget omitted mandatory ${id}`); }
