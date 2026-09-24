/** Application-owned release-brief files and deterministic acceptance checks. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@ditto/core/contracts";
import type { RegisteredTool } from "@ditto/core/worker/interaction";

export interface CatalogEntry { id: string; fields: string[] }
export interface BriefSpec { required: string[]; catalog: CatalogEntry[]; initialDraft: Record<string, string>; initialEvidence: string[] }
export interface Evidence { sourceId: string; sha256: string; value: string }
export interface Attempt { field: string; sourceId: string; found: boolean }
export interface BriefState { draft: Record<string, string>; evidence: Record<string, Evidence>; attempts: Attempt[]; revision: number }
export interface Snapshot extends BriefState { required: string[]; catalog: CatalogEntry[]; missing: string[]; issues: string[]; complete: boolean; blocked: boolean }
export type Action = { kind: "search"; field: string; sourceId: string } | { kind: "repair"; field: string };
export type StopReason = "goal" | "budget" | "round-limit" | "blocked";
export interface RoundRecord { round: number; action: string; modelCalls: number; snapshot: Snapshot; next: Action | null }
export interface BriefReport { reason: StopReason; status: "completed" | "stopped"; rounds: number; modelCalls: number; snapshot: Snapshot }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value) || ["constructor", "prototype"].includes(value)) throw new Error("Invalid brief identifier");
  return value;
}
function fields(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Expected at most sixteen fields");
  const result = value.map(id);
  if (new Set(result).size !== result.length) throw new Error("Duplicate fields");
  return result;
}
function strings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(object(value))) {
    id(key);
    if (typeof text !== "string" || !text.trim() || text.length > 2000 || /[\r\n]/.test(text)) throw new Error("Expected a nonempty single-line value");
    result[key] = text;
  }
  return result;
}
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
export function parseSpec(value: unknown): BriefSpec {
  const data = object(value), required = fields(data.required);
  if (!Array.isArray(data.catalog) || data.catalog.length > 32) throw new Error("Expected at most thirty-two sources");
  const catalog = data.catalog.map(item => { const entry = object(item); return { id: id(entry.id), fields: fields(entry.fields) }; });
  if (new Set(catalog.map(item => item.id)).size !== catalog.length) throw new Error("Duplicate sources");
  const initialDraft = strings(data.initialDraft ?? {}), initialEvidence = fields(data.initialEvidence ?? []);
  if (Object.keys(initialDraft).some(field => !required.includes(field)) || initialEvidence.some(source => !catalog.some(item => item.id === source))) throw new Error("Unknown initial field or source");
  return { required, catalog, initialDraft, initialEvidence };
}
export function candidates(snapshot: Snapshot, field: string): CatalogEntry[] {
  return snapshot.catalog.filter(source => source.fields.includes(field) && !snapshot.attempts.some(attempt => attempt.field === field && attempt.sourceId === source.id));
}
export function validateAction(value: unknown, snapshot: Snapshot): Action {
  const action = object(value), field = id(action.field);
  if (action.kind === "search" && snapshot.missing.includes(field) && candidates(snapshot, field).some(source => source.id === action.sourceId)) return { kind: "search", field, sourceId: id(action.sourceId) };
  if (action.kind === "repair" && snapshot.issues.includes(field) && snapshot.evidence[field]) return { kind: "repair", field };
  throw new Error("Plan must address an unresolved field using available evidence or an untried source");
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** One adapter per task directory. A fresh run requires a fresh output directory. */
export function createBriefFiles(options: { inputDirectory: string; outputDirectory: string }) {
  const directory = resolve(options.outputDirectory), statePath = join(directory, "state.json");
  const spec = async () => parseSpec(await readJson(join(directory, "spec.json")));
  const state = async () => await readJson(statePath) as BriefState;
  async function source(sourceId: string): Promise<{ facts: Record<string, string>; sha256: string } | null> {
    const root = await realpath(options.inputDirectory);
    let path: string;
    try { path = await realpath(join(root, `${id(sourceId)}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Source outside the input directory");
    const bytes = await readFile(path);
    if (bytes.length > 1024 * 1024) throw new Error("Source exceeds one MiB");
    return { facts: strings(object(JSON.parse(bytes.toString("utf8"))).facts), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async function inspect(): Promise<Snapshot> {
    const definition = await spec(), current = await state();
    // A stale or modified source cannot keep an earlier goal check green.
    for (const [field, evidence] of Object.entries(current.evidence)) {
      const loaded = await source(evidence.sourceId);
      if (!loaded || loaded.sha256 !== evidence.sha256 || loaded.facts[field] !== evidence.value) throw new Error("Evidence source changed; start a fresh task");
    }
    const missing = definition.required.filter(field => !current.evidence[field]);
    const issues = definition.required.filter(field => !current.evidence[field] || current.draft[field] !== current.evidence[field]!.value);
    const snapshot: Snapshot = { ...current, required: definition.required, catalog: definition.catalog, missing, issues, complete: issues.length === 0, blocked: false };
    snapshot.blocked = missing.some(field => candidates(snapshot, field).length === 0);
    return snapshot;
  }
  function tool(name: string, effects: ("read" | "write")[], execute: (args: JsonObject) => Promise<unknown>): RegisteredTool {
    return { name, effects, inputSchema: { type: "object" }, validate(args) { object(args); }, async execute(args, context) {
      context.signal?.throwIfAborted();
      return { status: "success", structuredContent: json(await execute(args)) as JsonValue };
    } };
  }
  const tools = [
    tool("brief_open", ["read", "write"], async () => {
      const definition = parseSpec(await readJson(join(options.inputDirectory, "spec.json")));
      const current: BriefState = { draft: definition.initialDraft, evidence: {}, attempts: [], revision: 0 };
      for (const sourceId of definition.initialEvidence) {
        const loaded = await source(sourceId);
        if (!loaded) throw new Error("Initial evidence source was not found");
        for (const field of definition.required) if (definition.catalog.find(item => item.id === sourceId)!.fields.includes(field) && loaded.facts[field]) {
          if (current.evidence[field] && current.evidence[field]!.value !== loaded.facts[field]) throw new Error("Conflicting initial evidence");
          current.evidence[field] = { sourceId, sha256: loaded.sha256, value: loaded.facts[field]! };
        }
      }
      await mkdir(directory); // EEXIST prevents accidental reuse or concurrent runs.
      await mkdir(join(directory, "rounds")); await mkdir(join(directory, "revisions"));
      await atomic(join(directory, "spec.json"), definition); await atomic(statePath, current);
      await atomic(join(directory, "revisions/0.json"), current.draft);
      return inspect();
    }),
    tool("brief_search", ["read", "write"], async args => {
      const before = await inspect(), action = validateAction({ kind: "search", ...args }, before);
      if (action.kind !== "search") throw new Error("Search action required");
      const loaded = await source(action.sourceId), current = await state();
      const found = !!loaded?.facts[action.field];
      current.attempts.push({ field: action.field, sourceId: action.sourceId, found });
      if (found) current.evidence[action.field] = { sourceId: action.sourceId, sha256: loaded!.sha256, value: loaded!.facts[action.field]! };
      await atomic(statePath, current);
      return inspect();
    }),
    tool("brief_patch", ["read", "write"], async args => {
      const before = await inspect(), patches = strings(args.patches), current = await state();
      if (!Object.keys(patches).length) throw new Error("At least one patch required");
      for (const field of Object.keys(patches)) validateAction({ kind: "repair", field }, before);
      Object.assign(current.draft, patches); current.revision++;
      await atomic(join(directory, `revisions/${current.revision}.json`), current.draft); await atomic(statePath, current);
      return inspect();
    }),
    tool("brief_check", ["read"], inspect),
    tool("brief_record", ["read", "write"], async args => {
      if (!Number.isSafeInteger(args.round) || Number(args.round) < 1 || !Number.isSafeInteger(args.modelCalls) || Number(args.modelCalls) < 0 || typeof args.action !== "string") throw new Error("Invalid round record");
      const snapshot = await inspect(), next = args.next === null ? null : validateAction(args.next, snapshot);
      const record = { round: args.round, action: args.action, modelCalls: args.modelCalls, snapshot, next };
      await writeFile(join(directory, `rounds/${args.round}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
      return record;
    }),
    tool("brief_finish", ["read", "write"], async args => {
      const snapshot = await inspect();
      if (!["goal", "budget", "round-limit", "blocked"].includes(String(args.reason)) || (args.reason === "goal") !== snapshot.complete || (args.reason === "blocked" && !snapshot.blocked)) throw new Error("Invalid stop reason for the persisted task");
      if (!Number.isSafeInteger(args.rounds) || Number(args.rounds) < 0 || !Number.isSafeInteger(args.modelCalls) || Number(args.modelCalls) < 0) throw new Error("Invalid task counters");
      const report: BriefReport = { reason: args.reason as StopReason, status: snapshot.complete ? "completed" : "stopped", rounds: Number(args.rounds), modelCalls: Number(args.modelCalls), snapshot };
      // JSON is the canonical artifact; Markdown is a readable projection of verified fields.
      const escape = (text: string) => text.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
      await writeFile(join(directory, "brief.md"), `# Release brief\n\nStatus: ${report.status} (${report.reason})\n\n` + snapshot.required.map(field => `- ${field}: ${escape(snapshot.draft[field] ?? "[missing]")}`).join("\n") + "\n");
      await atomic(join(directory, "result.json"), report);
      return report;
    }),
  ];
  return { tools, directory, inspect };
}
