/** Application-owned task state, triggers and transactional business effects. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@codesoul-co/ditto/contracts";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
export type Stage = "waiting" | "queued" | "running" | "blocked" | "stopped" | "failed" | "completed";
export type Trigger = { kind: "manual" } | { kind: "time"; dueAt: number } | { kind: "event" };
export interface Release { id: string; revision: number; status: "draft" | "ready" | "withdrawn"; title: string; change: string }
export interface Notice { releaseId: string; revision: number; title: string; body: string }
export interface Task { id: string; releaseId: string; expectedRevision: number; stage: Stage; reason: string | null; trigger: Trigger; deadlineAt: number | null; modelCallBudget: number; modelCalls: number; owner: string | null; createdAt: number; updatedAt: number }
export interface Event { id: string; type: "release.ready"; taskId: string; releaseId: string; revision: number }
export interface Result { job: Task; release: Release; notice: Notice | null; history: { seq: number; at: number; stage: Stage; reason: string | null }[] }
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
export function id(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid ID"); return value; }
function integer(value: unknown, min = 0): number { if (!Number.isSafeInteger(value) || Number(value) < min) throw new Error("Invalid integer"); return Number(value); }
function text(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text"); return value; }
export function release(value: unknown): Release { const x = object(value); if (!["draft", "ready", "withdrawn"].includes(String(x.status))) throw new Error("Invalid release status"); return { id: id(x.id), revision: integer(x.revision, 1), status: x.status as Release["status"], title: text(x.title, 200), change: text(x.change, 1000) }; }
export function notice(value: unknown): Notice { const x = object(value); return { releaseId: id(x.releaseId), revision: integer(x.revision, 1), title: text(x.title, 200), body: text(x.body, 4000) }; }
export function event(value: unknown): Event { const x = object(value); if (x.type !== "release.ready") throw new Error("Unsupported event type"); return { id: id(x.id), type: x.type, taskId: id(x.taskId), releaseId: id(x.releaseId), revision: integer(x.revision, 1) }; }
const terminal = (stage: Stage) => ["stopped", "failed", "completed"].includes(stage);
export class LifecycleStore {
  readonly directory: string;
  readonly db: DatabaseSync;
  constructor(directory: string) {
    this.directory = directory; this.db = new DatabaseSync(join(directory, "lifecycle.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(taskId TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY,taskId TEXT,at INTEGER,stage TEXT,reason TEXT);`);
  }
  private tx<T>(run: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value = run(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  job(taskId: string): Task { const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id(taskId)); if (!row) throw new Error("Unknown task"); return JSON.parse(String(row.data)) as Task; }
  business(releaseId: string): Release { const row = this.db.prepare("SELECT data FROM releases WHERE id=?").get(id(releaseId)); if (!row) throw new Error("Unknown release"); return release(JSON.parse(String(row.data))); }
  private save(job: Task, stage: Stage, reason: string | null = null) {
    job.stage = stage; job.reason = reason; job.updatedAt = Date.now();
    this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(job), job.id);
    this.db.prepare("INSERT INTO history(taskId,at,stage,reason) VALUES(?,?,?,?)").run(job.id, job.updatedAt, stage, reason);
  }
  async create(taskId: string, trigger: Trigger = { kind: "manual" }, limits: { deadlineAt?: number; modelCallBudget?: number } = {}): Promise<Task> {
    id(taskId);
    if (trigger.kind === "time") integer(trigger.dueAt);
    else if (!["manual", "event"].includes(trigger.kind)) throw new Error("Invalid trigger");
    const source = release(JSON.parse(await readFile(join(this.directory, `${taskId}.source.json`), "utf8")));
    const job: Task = { id: taskId, releaseId: source.id, expectedRevision: source.revision, stage: trigger.kind === "manual" ? "queued" : "waiting", reason: null, trigger,
      deadlineAt: limits.deadlineAt === undefined ? null : integer(limits.deadlineAt), modelCallBudget: integer(limits.modelCallBudget ?? 1), modelCalls: 0, owner: null, createdAt: Date.now(), updatedAt: Date.now() };
    return this.tx(() => {
      const existing = this.db.prepare("SELECT data FROM releases WHERE id=?").get(source.id);
      if (existing && JSON.stringify(release(JSON.parse(String(existing.data)))) !== JSON.stringify(source)) throw new Error("Release input conflicts with business state");
      this.db.prepare("INSERT OR IGNORE INTO releases VALUES(?,?)").run(source.id, JSON.stringify(source));
      this.db.prepare("INSERT INTO tasks VALUES(?,?)").run(job.id, JSON.stringify(job)); this.save(job, job.stage); return job;
    });
  }
  /** Trusted application controller; business updates are not model tools. */
  updateBusiness(value: Release): void { const next = release(value); this.tx(() => { const current = this.business(next.id); if (next.revision < current.revision || (next.revision === current.revision && (next.title !== current.title || next.change !== current.change))) throw new Error("Content changes require a new revision"); this.db.prepare("UPDATE releases SET data=? WHERE id=?").run(JSON.stringify(next), next.id); }); }
  requestStop(taskId: string, reason = "OPERATOR_STOP"): Task { text(reason, 200); return this.tx(() => { const job = this.job(taskId); if (!terminal(job.stage)) this.save(job, "stopped", reason); return job; }); }
  private expired(job: Task): boolean { if (job.deadlineAt !== null && Date.now() >= job.deadlineAt) { this.save(job, "stopped", "DEADLINE"); return true; } return false; }
  /** Atomic deduplication and trigger activation, normally called by the file adapter. */
  acceptEvent(value: Event): Task {
    const incoming = event(value);
    return this.tx(() => {
      const previous = this.db.prepare("SELECT data FROM events WHERE id=?").get(incoming.id);
      if (previous) { if (String(previous.data) !== JSON.stringify(incoming)) throw new Error("Event ID payload conflict"); return this.job(incoming.taskId); }
      const job = this.job(incoming.taskId);
      if (job.trigger.kind !== "event" || incoming.releaseId !== job.releaseId || incoming.revision !== job.expectedRevision) throw new Error("Event does not match task scope");
      this.db.prepare("INSERT INTO events VALUES(?,?)").run(incoming.id, JSON.stringify(incoming));
      if (job.stage === "waiting" && !this.expired(job)) this.save(job, "queued", "EVENT_RECEIVED"); return job;
    });
  }
  private async activate(taskId: string): Promise<Task> {
    let job = this.job(taskId);
    if (job.stage !== "waiting") return job;
    if (job.trigger.kind === "event") {
      const path = join(this.directory, "inbox", `${job.id}.json`);
      let bytes: string;
      try { bytes = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return this.tx(() => { const current = this.job(taskId); if (current.stage === "waiting") this.expired(current); return current; }); }
      if (bytes.length > 16_384) throw new Error("Event exceeds size limit");
      const incoming = event(JSON.parse(bytes)); if (incoming.taskId !== taskId) throw new Error("Event file belongs to another task");
      job = this.acceptEvent(incoming);
    } else job = this.tx(() => { const current = this.job(taskId); if (current.stage === "waiting" && !this.expired(current) && current.trigger.kind === "time" && Date.now() >= current.trigger.dueAt) this.save(current, "queued", "TIME_REACHED"); return current; });
    return job;
  }
  private claim(taskId: string): { job: Task; claimed: boolean } {
    return this.tx(() => {
      const job = this.job(taskId);
      if (!["queued", "blocked"].includes(job.stage)) return { job, claimed: false };
      if (this.expired(job)) return { job, claimed: false };
      const source = this.business(job.releaseId);
      if (source.status !== "ready" || source.revision !== job.expectedRevision) { if (job.stage !== "blocked") this.save(job, "blocked", "BUSINESS_STATE"); return { job, claimed: false }; }
      if (job.modelCalls >= job.modelCallBudget) { this.save(job, "stopped", "MODEL_CALL_BUDGET"); return { job, claimed: false }; }
      job.owner = randomUUID(); job.modelCalls++; this.save(job, "running"); return { job, claimed: true };
    });
  }
  private commit(taskId: string, owner: string, value: unknown, signal?: AbortSignal): Task {
    signal?.throwIfAborted();
    return this.tx(() => {
      const job = this.job(taskId);
      if (job.stage !== "running" || job.owner !== owner) return job;
      if (this.expired(job)) return job;
      const source = this.business(job.releaseId);
      if (source.status !== "ready" || source.revision !== job.expectedRevision) { this.save(job, "blocked", "BUSINESS_CHANGED"); return job; }
      const output = notice(value);
      if (output.releaseId !== source.id || output.revision !== source.revision || output.title !== source.title || !output.body.includes(source.change)) throw new Error("Notice does not preserve source facts");
      signal?.throwIfAborted();
      this.db.prepare("INSERT INTO notices VALUES(?,?)").run(job.id, JSON.stringify(output)); this.save(job, "completed"); return job;
    });
  }
  result(taskId: string): Result {
    const job = this.job(taskId), saved = this.db.prepare("SELECT data FROM notices WHERE taskId=?").get(taskId);
    return { job, release: this.business(job.releaseId), notice: saved ? notice(JSON.parse(String(saved.data))) : null,
      history: this.db.prepare("SELECT seq,at,stage,reason FROM history WHERE taskId=? ORDER BY seq").all(taskId).map(row => ({ seq: Number(row.seq), at: Number(row.at), stage: String(row.stage) as Stage, reason: row.reason === null ? null : String(row.reason) })) };
  }
  get tools(): RegisteredTool[] {
    const tool = (name: string, execute: RegisteredTool["execute"]): RegisteredTool => ({ name, effects: ["read", "write"], inputSchema: { type: "object", required: ["id"] }, validate(args) { id(args.id); }, execute });
    const ok = (value: unknown) => ({ status: "success" as const, structuredContent: json(value) });
    return [
      tool("lifecycle_read", async args => ok(this.result(String(args.id)))),
      tool("lifecycle_activate", async args => ok(await this.activate(String(args.id)))),
      tool("lifecycle_claim", async args => ok(this.claim(String(args.id)))),
      tool("lifecycle_source", async args => { const job = this.job(String(args.id)); if (job.stage !== "running" || job.owner !== args.owner) throw new Error("Execution ownership lost"); return ok(this.business(job.releaseId)); }),
      tool("lifecycle_commit", async (args, context) => ok(this.commit(String(args.id), String(args.owner), args.notice, context.signal))),
      tool("lifecycle_finish", async args => ok(this.tx(() => {
        const job = this.job(String(args.id));
        if (!terminal(job.stage) && (job.owner === args.owner || (job.owner === null && args.owner === null))) {
          if (args.stage !== "failed" && args.stage !== "stopped") throw new Error("Invalid terminal status"); this.save(job, args.stage, text(args.reason, 200));
        } return job;
      }))),
      tool("lifecycle_report", async args => {
        const result = this.result(String(args.id)), directory = join(this.directory, "results"); await mkdir(directory, { recursive: true });
        const path = join(directory, `${result.job.id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
        return ok(result);
      }),
    ];
  }
  close(): void { this.db.close(); }
}
