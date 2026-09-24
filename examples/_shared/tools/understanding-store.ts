/** Application-owned conversations, grounded request parameters and local report delivery. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import type { OutputSink, RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
export type Mode = "goal" | "constraints" | "clarification" | "conversation" | "choices" | "intent";
export type Stage = "received" | "analyzing" | "needs_clarification" | "awaiting_choice" | "ready" | "completed" | "answered" | "blocked" | "cancelled" | "failed";
export interface Turn { id: string; role: "user" | "assistant"; text: string }
export interface Analysis {
  intent: "create_report" | "status" | "cancel" | "unknown";
  topic: string | null; audience: "engineering" | "customers" | null;
  deadline: string | null; format: "markdown" | "json" | null; budgetCents: number | null;
  permission: "draft_only" | "publish" | null; scope: ("changes" | "metrics")[] | null;
  evidence: Record<string, { turnId: string; quote: string }>;
}
export interface Source { topic: string; changes: string[]; metrics: { testsPassed: number; fixes: number } }
export interface Choice { id: "brief" | "detailed"; label: string; costCents: number; description: string }
export interface View { sessionId: string; revision: number; kind: Stage; text: string; missing: string[]; choices: Choice[]; analysis: Analysis | null; artifact: Artifact | null; token: string; delivered: boolean }
export interface Artifact { revision: number; format: "markdown" | "json"; file: string; content: { topic: string; audience: string; deadline: string; style: string; costCents: number; sections: Record<string, unknown> } }
export interface Session { id: string; mode: Mode; revision: number; stage: Stage; reason: string | null; owner: string | null; turns: Turn[]; namespace: string; memoryRevision: number; analysis: Analysis | null; selected: Choice | null; view: View | null; artifact: Artifact | null; source: Source; sourceDigest: string; modelCalls: number }
export const fields = ["topic", "audience", "deadline", "format", "budgetCents", "permission", "scope"] as const;
export const choices: readonly Choice[] = [
  { id: "brief", label: "简版报告", costCents: 500, description: "保留所选范围内的事实，以紧凑结构呈现。" },
  { id: "detailed", label: "详细报告", costCents: 1000, description: "保留同样的事实，并增加阅读指引和验收信息。" },
];
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export function id(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid identifier"); return value; }
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text"); return value; }
function one<const T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) throw new Error("Unsupported parameter value"); return value as T; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function analysis(value: unknown, turns: Turn[]): Analysis {
  const x = object(value), provenance = object(x.evidence);
  const result: Analysis = { intent: one(x.intent, ["create_report", "status", "cancel", "unknown"]), topic: x.topic === null ? null : text(x.topic, 100),
    audience: x.audience === null ? null : one(x.audience, ["engineering", "customers"]), deadline: x.deadline === null ? null : text(x.deadline, 40),
    format: x.format === null ? null : one(x.format, ["markdown", "json"]), budgetCents: x.budgetCents === null ? null : Number(x.budgetCents),
    permission: x.permission === null ? null : one(x.permission, ["draft_only", "publish"]), scope: x.scope === null ? null : [], evidence: {} };
  if (result.deadline !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(result.deadline) || !Number.isFinite(Date.parse(result.deadline)) || new Date(result.deadline).toISOString() !== result.deadline)) throw new Error("Expected a valid UTC deadline");
  if (result.budgetCents !== null && (typeof x.budgetCents !== "number" || !Number.isSafeInteger(x.budgetCents) || x.budgetCents < 0 || x.budgetCents > 1_000_000)) throw new Error("Invalid budget");
  if (x.scope !== null) { if (!Array.isArray(x.scope) || !x.scope.length || x.scope.length > 2) throw new Error("Invalid scope"); result.scope = x.scope.map(v => one(v, ["changes", "metrics"])); if (new Set(result.scope).size !== result.scope.length) throw new Error("Duplicate scope"); }
  for (const field of ["intent", ...fields] as const) {
    if (result[field] === null || (field === "intent" && result.intent === "unknown")) continue;
    const entry = object(provenance[field]), turnId = id(entry.turnId), quote = text(entry.quote, 1000);
    if (!turns.some(turn => turn.id === turnId && turn.role === "user" && turn.text.includes(quote))) throw new Error(`Ungrounded parameter: ${field}`);
    result.evidence[field] = { turnId, quote };
  }
  return result;
}
export class StaleTurnError extends Error { constructor() { super("Conversation changed during execution"); } }
async function immutable(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error; }
  } finally { await rm(temporary, { force: true }); }
}
export class UnderstandingStore {
  readonly directory: string; readonly db: DatabaseSync;
  constructor(directory: string) {
    this.directory = directory; this.db = new DatabaseSync(join(directory, "understanding.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(sessionId TEXT,revision INTEGER,data TEXT NOT NULL,PRIMARY KEY(sessionId,revision));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,sessionId TEXT,kind TEXT,data TEXT);`);
  }
  private tx<T>(run: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = run(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  session(sessionId: string): Session { const row = this.db.prepare("SELECT data FROM sessions WHERE id=?").get(id(sessionId)); if (!row) throw new Error("Unknown session"); return JSON.parse(String(row.data)) as Session; }
  private save(s: Session, kind: string) { this.db.prepare("UPDATE sessions SET data=? WHERE id=?").run(JSON.stringify(s), s.id); this.db.prepare("INSERT INTO events(sessionId,kind,data) VALUES(?,?,?)").run(s.id, kind, JSON.stringify({ revision: s.revision, stage: s.stage, reason: s.reason })); }
  async create(sessionId: string, mode: Mode, message: string): Promise<Session> {
    id(sessionId); one(mode, ["goal", "constraints", "clarification", "conversation", "choices", "intent"]); text(message, 8000);
    const raw = object(JSON.parse(await readFile(join(this.directory, "source.json"), "utf8"))), m = object(raw.metrics);
    if (!Array.isArray(raw.changes) || raw.changes.length > 20) throw new Error("Invalid changes");
    const source: Source = { topic: text(raw.topic, 100), changes: raw.changes.map(x => text(x, 1000)), metrics: { testsPassed: Number(m.testsPassed), fixes: Number(m.fixes) } };
    if (Object.values(source.metrics).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("Invalid source metrics");
    const s: Session = { id: sessionId, mode, revision: 1, stage: "received", reason: null, owner: null, turns: [{ id: "user-1", role: "user", text: message }], namespace: randomUUID(), memoryRevision: 0, analysis: null, selected: null, view: null, artifact: null, source, sourceDigest: digest(raw), modelCalls: 0 };
    this.tx(() => { this.db.prepare("INSERT INTO sessions VALUES(?,?)").run(s.id, JSON.stringify(s)); this.save(s, "created"); }); return s;
  }
  /** Called by an authenticated application controller, never a model tool. */
  receive(input: { id: string; messageId: string; text: string; expectedRevision: number; replyToken?: string }): Session {
    id(input.messageId); text(input.text, 8000);
    return this.tx(() => {
      const s = this.session(input.id), previous = s.turns.find(t => t.id === input.messageId);
      if (previous) { if (previous.role !== "user" || previous.text !== input.text) throw new Error("Message ID conflict"); return s; }
      if (s.revision !== input.expectedRevision) throw new StaleTurnError();
      if (["needs_clarification", "awaiting_choice"].includes(s.stage) && (!s.view?.delivered || s.view.token !== input.replyToken)) throw new Error("Reply requires the delivered question token");
      if (s.turns.length >= 40) throw new Error("Conversation turn limit reached");
      s.turns.push({ id: input.messageId, role: "user", text: input.text }); s.revision++; s.stage = "received"; s.reason = null; s.owner = null; s.view = null; s.selected = null;
      this.save(s, "user-message"); return s;
    });
  }
  choose(input: { id: string; expectedRevision: number; token: string; choiceId: string }): Session {
    return this.tx(() => {
      const s = this.session(input.id), option = s.view?.choices.find(c => c.id === input.choiceId);
      if (s.stage !== "awaiting_choice" || s.revision !== input.expectedRevision || !s.view?.delivered || s.view.token !== input.token || !option) throw new Error("Stale or invalid choice");
      s.selected = option; s.revision++; s.turns.push({ id: `choice-${s.revision}`, role: "user", text: `选择 ${option.id} 方案，预算为本次请求中已给出的上限。` }); s.stage = "ready"; s.view = null; this.save(s, "user-choice"); return s;
    });
  }
  private current(sessionId: string, revision: number, owner: string): Session { const s = this.session(sessionId); if (s.revision !== revision || s.owner !== owner) throw new StaleTurnError(); return s; }
  private classify(s: Session) {
    const a = s.analysis!;
    if (a.intent === "cancel") { s.stage = "cancelled"; s.reason = "USER_CANCELLED"; return; }
    if (a.intent === "status") { s.stage = "answered"; s.reason = null; return; }
    if (a.intent === "unknown" || fields.some(f => a[f] === null)) { s.stage = "needs_clarification"; s.reason = "MISSING_INFORMATION"; return; }
    const reason = a.topic !== s.source.topic ? "UNKNOWN_TOPIC" : a.permission !== "draft_only" ? "POLICY_DENIED" : Date.parse(a.deadline!) <= Date.now() ? "DEADLINE_EXPIRED" : a.budgetCents! < (s.selected?.costCents ?? 500) ? "BUDGET_EXCEEDED" : null;
    if (reason) { s.stage = "blocked"; s.reason = reason; return; }
    s.reason = null; s.stage = s.mode === "choices" && !s.selected ? "awaiting_choice" : "ready";
  }
  private view(s: Session): View {
    const missing = s.analysis?.intent === "unknown" ? ["intent"] : fields.filter(f => !s.analysis || s.analysis[f] === null);
    const labels: Record<string, string> = { intent: "希望生成发布报告、查询进度还是取消任务", topic: "报告对应的项目名称", audience: "面向工程团队还是客户", deadline: "带日期与时区的截止时间", format: "Markdown 或 JSON 格式", budgetCents: "预算金额（人民币或分）", permission: "仅生成草稿还是要求发布", scope: "包含变更记录、指标或两者" };
    const options = s.stage === "awaiting_choice" ? choices.filter(c => c.costCents <= s.analysis!.budgetCents!) : [];
    const content = s.stage === "needs_clarification" ? `为继续处理，请补充：${missing.map(f => labels[f]).join("；")}。`
      : s.stage === "awaiting_choice" ? "请选择报告方案；选择后按同一组约束生成草稿。"
      : s.stage === "answered" ? `当前已有报告：${s.artifact ? `第 ${s.artifact.revision} 版，${s.artifact.format} 格式` : "尚未生成"}。`
      : s.stage === "completed" ? "已按确认的请求生成本地报告草稿。"
      : s.stage === "blocked" ? `请求无法执行：${s.reason}。` : s.stage === "cancelled" ? "已停止本轮请求，保留此前产物。" : `请求处理失败：${s.reason}。`;
    const body = { sessionId: s.id, revision: s.revision, kind: s.stage, text: content, missing: s.stage === "needs_clarification" ? missing : [], choices: options, analysis: s.analysis, artifact: s.artifact };
    return { ...body, token: digest(body), delivered: false };
  }
  private async registerReport(sessionId: string, revision: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const raw = JSON.parse(await readFile(join(this.directory, "source.json"), "utf8"));
    return this.tx(() => {
      const s = this.session(sessionId); if (s.revision !== revision) throw new StaleTurnError();
      if (s.stage !== "ready") return s;
      if (digest(raw) !== s.sourceDigest) { s.stage = "blocked"; s.reason = "SOURCE_CHANGED"; this.save(s, "source-changed"); return s; }
      this.classify(s); if (s.stage !== "ready") { this.save(s, "constraints-blocked"); return s; }
      const a = s.analysis!, option = s.selected ?? choices[0]!;
      const sections: Record<string, unknown> = {};
      for (const scope of a.scope!) sections[scope] = s.source[scope];
      const artifact: Artifact = { revision, format: a.format!, file: `artifacts/${s.id}-r${revision}.${a.format === "json" ? "json" : "md"}`, content: { topic: a.topic!, audience: a.audience!, deadline: a.deadline!, style: option.id, costCents: option.costCents, sections } };
      signal?.throwIfAborted(); this.db.prepare("INSERT INTO artifacts VALUES(?,?,?)").run(s.id, revision, JSON.stringify(artifact));
      s.artifact = artifact; s.stage = "completed"; this.save(s, "report-registered"); return s;
    });
  }
  private async exportArtifact(s: Session) {
    if (!s.artifact) return; const a = s.artifact; await mkdir(join(this.directory, "artifacts"), { recursive: true });
    const content = a.format === "json" ? JSON.stringify(a.content, null, 2) + "\n" : `# ${a.content.topic}\n\nAudience: ${a.content.audience}\nDeadline: ${a.content.deadline}\nStyle: ${a.content.style}\nCost: ${a.content.costCents} cents\n\n` + Object.entries(a.content.sections).map(([key, value]) => `## ${key}\n\n${JSON.stringify(value, null, 2)}\n`).join("\n") + (a.content.style === "detailed" ? "\n## Reading guide\n\nReview each selected section against the source. This document is a local draft.\n" : "");
    await immutable(join(this.directory, a.file), content);
  }
  get tools(): RegisteredTool[] {
    const tool = (name: string, execute: RegisteredTool["execute"]): RegisteredTool => ({ name, effects: ["read", "write"], inputSchema: { type: "object", required: ["id"] }, validate(args) { id(args.id); }, execute });
    const ok = (value: unknown) => ({ status: "success" as const, structuredContent: json(value) });
    return [
      tool("understanding_read", async args => ok(this.session(String(args.id)))),
      tool("understanding_claim", async args => ok(this.tx(() => { const s = this.session(String(args.id)); if (s.stage !== "received") return { claimed: false, session: s }; s.stage = "analyzing"; s.owner = randomUUID(); s.modelCalls++; this.save(s, "analysis-started"); return { claimed: true, session: s }; }))),
      tool("understanding_release", async args => ok(this.tx(() => { const s = this.current(String(args.id), Number(args.revision), String(args.owner)); if (s.stage === "analyzing") { s.stage = "received"; s.owner = null; this.save(s, "storage-retry"); } return s; }))),
      tool("understanding_archived", async args => ok(this.tx(() => { const s = this.session(String(args.id)); if (s.revision !== args.revision || !s.view?.delivered) throw new StaleTurnError(); s.memoryRevision = s.revision; this.save(s, "memory-archived"); return s; }))),
      tool("understanding_analyze", async args => ok(this.tx(() => { const s = this.current(String(args.id), Number(args.revision), String(args.owner)); if (s.stage !== "analyzing") throw new StaleTurnError(); s.analysis = analysis(args.analysis, s.turns); this.classify(s); this.save(s, "request-understood"); return s; }))),
      tool("understanding_execute", async (args, context) => ok(await this.registerReport(String(args.id), Number(args.revision), context.signal))),
      tool("understanding_fail", async args => ok(this.tx(() => { const s = this.session(String(args.id)); if (s.revision === args.revision && s.owner === args.owner && s.stage === "analyzing") { s.stage = args.cancelled ? "cancelled" : "failed"; s.reason = args.cancelled ? "CALLER_CANCELLED" : "MODEL_INVALID_OR_FAILED"; this.save(s, "analysis-failed"); } return s; }))),
      tool("understanding_view", async args => { const s = this.session(String(args.id)); await this.exportArtifact(s); return ok(this.tx(() => { const latest = this.session(s.id); if (latest.revision !== s.revision) throw new StaleTurnError(); if (!latest.view) { latest.view = this.view(latest); this.save(latest, "response-prepared"); } return latest.view; })); }),
      tool("understanding_report", async args => { const s = this.session(String(args.id)); const directory = join(this.directory, "results"); await mkdir(directory, { recursive: true }); const path = join(directory, `${s.id}.json`), temporary = `${path}.${randomUUID()}.tmp`; try { await writeFile(temporary, JSON.stringify(s, null, 2)); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } return ok(s); }),
    ];
  }
  readonly output: OutputSink = { deliver: async input => {
    const value = object(input.message.content), sessionId = id(value.sessionId), s = this.session(sessionId), v = s.view;
    if (!v || input.deliveryId !== `${s.id}-r${s.revision}` || value.token !== v.token || digest(value) !== digest({ ...v, delivered: false })) throw new StaleTurnError();
    const directory = join(this.directory, "inbox"); await mkdir(directory, { recursive: true });
    const path = join(directory, `${input.deliveryId}.json`); await immutable(path, JSON.stringify(value, null, 2) + "\n");
    await immutable(join(directory, `${input.deliveryId}.md`), `# ${v.kind}\n\n${v.text}\n\n${JSON.stringify(value, null, 2)}\n`);
    this.tx(() => { const latest = this.session(sessionId); if (latest.revision !== s.revision || latest.view?.token !== v.token) throw new StaleTurnError(); latest.view.delivered = true; const turnId = `assistant-${latest.revision}`; if (!latest.turns.some(t => t.id === turnId)) latest.turns.push({ id: turnId, role: "assistant", text: v.text + (v.choices.length ? JSON.stringify(v.choices) : "") }); this.save(latest, "response-delivered"); });
    return { deliveryId: input.deliveryId, status: "accepted", artifacts: [{ name: "response.json", reference: { uri: pathToFileURL(path).href, mediaType: "application/json" } }] };
  } };
  close() { this.db.close(); }
}
