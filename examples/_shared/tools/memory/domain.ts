import { createHash } from "node:crypto";
import type { JsonValue } from "@codesoul-co/ditto/contracts";
import type { MemoryItem } from "@codesoul-co/ditto/worker/memory";
export const backends = ["sqlite", "postgres", "qdrant"] as const;
export type Backend = typeof backends[number];
export const modes = ["search", "write", "update", "task-state"] as const;
export type Mode = typeof modes[number];
export interface Request { id: string; tenant: string; user: string; mode: Mode; backend: Backend; statement: string; remember: boolean }
export interface Preference { text: string; language: "Chinese" | "English"; style: "concise" | "detailed"; version: number; operationId: string }
export interface Project { ticket: string; completed: number; total: number }
export interface Progress extends Project { remaining: number; phase: "prepared" }
export interface Report { taskId: string; namespace: string; mode: Mode; backend: Backend; memoryId: string; version: number; language: string; style: string; message: string; progress: Progress }
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export const namespace = (r: Request) => `${r.tenant}:${r.user}`;
export const preferenceKey = (r: Request) => `${namespace(r)}:memory:communication`;
export const taskKey = (r: Request, stage: string) => `${namespace(r)}:task:${r.id}:${stage}`;
export function request(value: unknown): Request {
  const r = object(value); for (const key of ["id", "tenant", "user"]) if (typeof r[key] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(r[key])) throw new Error(`Invalid ${key}`);
  if (!modes.includes(r.mode as Mode) || !backends.includes(r.backend as Backend) || typeof r.remember !== "boolean" || typeof r.statement !== "string" || r.statement.length > 2000) throw new Error("Invalid memory request");
  return { id: r.id as string, tenant: r.tenant as string, user: r.user as string, mode: r.mode as Mode, backend: r.backend as Backend, statement: r.statement, remember: r.remember };
}
export function admitted(r: Request) {
  if (!r.remember) throw new Error("User has not enabled saving this preference");
  const match = /^For future project updates, use (Chinese|English) with (concise|detailed) explanations\.$/.exec(r.statement);
  if (!match) throw new Error("Only explicit, durable communication preferences may be saved");
  return { language: match[1] as Preference["language"], style: match[2] as Preference["style"] };
}
export function proposal(value: unknown, r: Request, version: number): Preference {
  const p = object(value), expected = admitted(r);
  if (p.language !== expected.language || p.style !== expected.style || p.quote !== r.statement) throw new Error("Proposed memory is not supported by the user's statement");
  return { text: `For project updates, the user prefers ${expected.language} with ${expected.style} explanations.`, ...expected, version, operationId: r.id };
}
export function preference(item: MemoryItem): Preference {
  const p = object(item.content);
  if (!["Chinese", "English"].includes(String(p.language)) || !["concise", "detailed"].includes(String(p.style)) || typeof p.text !== "string" || !Number.isSafeInteger(p.version) || Number(p.version) < 1 || typeof p.operationId !== "string") throw new Error("Invalid stored preference");
  return p as unknown as Preference;
}
export function project(value: unknown): Project {
  const p = object(value); if (typeof p.ticket !== "string" || !/^[A-Z]+-\d+$/.test(p.ticket) || !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total) || Number(p.completed) < 0 || Number(p.total) < Number(p.completed) || Number(p.total) > 10000) throw new Error("Invalid project input");
  return { ticket: p.ticket, completed: Number(p.completed), total: Number(p.total) };
}
export function progress(value: unknown, p: Project): Progress {
  const v = object(value); if (v.ticket !== p.ticket || v.completed !== p.completed || v.total !== p.total || v.remaining !== p.total - p.completed || v.phase !== "prepared") throw new Error("Invalid task progress");
  return { ...p, remaining: p.total - p.completed, phase: "prepared" };
}
export function report(value: unknown, r: Request, memory: MemoryItem, state: Progress): Report {
  const result = object(value), saved = preference(memory);
  if (result.language !== saved.language || result.style !== saved.style || result.memoryId !== memory.id || typeof result.message !== "string" || !result.message.includes(state.ticket) || !result.message.includes(String(state.remaining))) throw new Error("Report did not apply retrieved memory and task progress");
  if (saved.language === "Chinese" ? !/[\p{Script=Han}]/u.test(result.message) : /[\p{Script=Han}]/u.test(result.message)) throw new Error("Report language differs from memory");
  if (result.message.length < 30 || result.message.length > (saved.style === "concise" ? 400 : 2000) || (saved.style === "detailed" && result.message.length < 120)) throw new Error("Report does not meet the remembered style");
  return { taskId: r.id, namespace: namespace(r), mode: r.mode, backend: r.backend, memoryId: memory.id, version: saved.version, language: saved.language, style: saved.style, message: result.message, progress: state };
}
