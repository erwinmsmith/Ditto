import { createHash } from "node:crypto";
import type { JsonObject } from "@ditto/core/contracts";
export const modes = ["document-search", "knowledge-base", "web-search", "web-read", "multi-source", "rewrite", "expand", "source-location"] as const;
export type Mode = typeof modes[number];
export type Source = "documents" | "knowledge-internal" | "knowledge-external" | "web";
export interface Request {
  id: string; tenant: string; mode: Mode;
  knowledge: "internal" | "external" | "both"; internalKnowledgeKeys: string[]; question: string; query: string;
  vocabulary: string[]; documents: string[]; urls: string[]; allowedOrigins: string[];
  searchEngine: "wikipedia" | "brave"; allowPartial: boolean;
}
export interface Evidence {
  id: string; source: Source; uri: string; title: string; text: string;
  location: string; snapshot: string; queries: string[];
}
export interface Collected { evidence: Evidence[]; failures: { source: Source; code: string }[] }
export interface Finding { sourceId: string; quote: string }
export interface Report extends Collected {
  requestId: string; question: string; queries: string[]; findings: Finding[];
  status: "completed" | "partial" | "no-evidence";
}
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 600): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error("Invalid text");
  return value.trim();
}
export function request(value: unknown): Request {
  const r = object(value);
  if (!modes.includes(r.mode as Mode) || !["wikipedia", "brave"].includes(String(r.searchEngine)) || typeof r.allowPartial !== "boolean") throw new Error("Invalid request");
  for (const field of ["vocabulary", "documents", "urls", "allowedOrigins", "internalKnowledgeKeys"]) if (!Array.isArray(r[field]) || r[field].length > 12) throw new Error(`Invalid ${field}`);
  if (!["internal", "external", "both"].includes(String(r.knowledge))) throw new Error("Select internal, external or both knowledge sources");
  const result: Request = { knowledge: r.knowledge as Request["knowledge"], internalKnowledgeKeys: (r.internalKnowledgeKeys as unknown[]).map(v => text(v, 128)), id: text(r.id, 64), tenant: text(r.tenant, 64), mode: r.mode as Mode, question: text(r.question), query: text(r.query), vocabulary: (r.vocabulary as unknown[]).map(v => text(v, 64)), documents: (r.documents as unknown[]).map(v => text(v, 128)), urls: (r.urls as unknown[]).map(v => text(v, 2048)), allowedOrigins: (r.allowedOrigins as unknown[]).map(v => text(v, 256)), searchEngine: r.searchEngine as Request["searchEngine"], allowPartial: r.allowPartial };
  if (!/^[a-zA-Z0-9_-]+$/.test(result.id) || !/^[a-zA-Z0-9_-]+$/.test(result.tenant)) throw new Error("Invalid identity");
  if (new Set(result.internalKnowledgeKeys).size !== result.internalKnowledgeKeys.length || result.internalKnowledgeKeys.some(key => !key.startsWith(`knowledge:${result.tenant}:`) || !/^[a-zA-Z0-9:_-]+$/.test(key))) throw new Error("Internal knowledge key outside tenant");
  if (result.documents.some(v => !/^[a-zA-Z0-9_-]+\.md$/.test(v))) throw new Error("Document must be a Markdown filename");
  for (const origin of result.allowedOrigins) { const u = new URL(origin); if (u.origin !== origin || u.protocol !== "https:" || u.username || u.password) throw new Error("Invalid allowed origin"); }
  return result;
}
export function queries(value: unknown, r: Request): string[] {
  const v = object(value).queries;
  const limit = r.mode === "expand" ? 3 : 1;
  if (!Array.isArray(v) || !v.length || v.length > limit) throw new Error("Invalid query plan");
  const items = [...new Set(v.map(q => text(q, 200)))];
  if (["rewrite", "expand"].includes(r.mode) && items.some(q => !r.vocabulary.includes(q))) throw new Error("Query must be an exact supported vocabulary entry");
  if (r.mode === "expand" && items.length < 2) throw new Error("Expansion requires distinct queries");
  if (!["rewrite", "expand"].includes(r.mode) && (items.length !== 1 || items[0] !== r.query)) throw new Error("Query must preserve the trusted search topic");
  return items;
}
export function findings(value: unknown, evidence: Evidence[]): Finding[] {
  const items = object(value).findings;
  if (!Array.isArray(items) || !items.length || items.length > evidence.length) throw new Error("Invalid findings");
  const result = items.map(item => {
    const f = object(item), sourceId = text(f.sourceId, 128), quote = text(f.quote, 1000);
    const e = evidence.find(x => x.id === sourceId);
    if (!e || quote.length < 20 || !e.text.includes(quote)) throw new Error("Unsupported citation");
    return { sourceId, quote };
  });
  if (new Set(result.map(f => f.sourceId)).size !== result.length) throw new Error("Duplicate citation");
  // Cover every retrieved passage: no silent omission of a source or expanded query.
  if (result.length !== evidence.length) throw new Error("Missing source coverage");
  return result;
}
export const tokens = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 24);
export const sourceList = (r: Request): Source[] => {
  const knowledge: Source[] = r.knowledge === "internal" ? ["knowledge-internal"] : r.knowledge === "external" ? ["knowledge-external"] : ["knowledge-internal", "knowledge-external"];
  return r.mode === "multi-source" ? ["documents", ...knowledge, "web"] : r.mode === "knowledge-base" ? knowledge : ["web-search", "web-read"].includes(r.mode) ? ["web"] : ["documents"];
};
