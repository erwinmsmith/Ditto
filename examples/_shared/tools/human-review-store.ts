/** Application review inbox, versioned drafts and gated effects. Approval is never a model tool. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, JsonObject } from "@ditto/core/contracts";
import type { OutputSink, RegisteredTool } from "@ditto/core/worker/interaction";

export type HumanMode = "approval" | "intermediate" | "edit" | "publish" | "escalation";
export type Purpose = "activate" | "intermediate" | "edit" | "publish" | "handoff";
export type HumanStage = "queued" | "drafted" | "awaiting-review" | "approved" | "rejected" | "executing" | "completed" | "escalated";
export interface Brief { releaseId: string; title: string; change: string; sources: { id: string; date: string }[] }
export interface Draft { releaseId: string; date: string; title: string; body: string }
export interface Version { version: number; digest: string; draft: Draft; author: string }
export interface HumanJob {
  schemaVersion: 1; id: string; mode: HumanMode; stage: HumanStage; revision: number;
  source: Brief; sourceDigest: string; targetBeforeDigest: string; context: Context | null;
  currentVersion: number; gateId: string | null; reason: string | null; assignee: string | null;
}
export interface ReviewSnapshot {
  taskId: string; purpose: Purpose; version: number; artifactDigest: string | null; proposal: Draft | null;
  sourceDigest: string; operation: { kind: string; target: string; beforeDigest: string | null };
  reason: string | null; handoff: { task: HumanJob; sources: Brief; context: Context | null; events: unknown[] } | null;
}
export interface ReviewRequest {
  id: string; taskId: string; token: string; snapshot: ReviewSnapshot; delivered: boolean;
  status: "pending" | "approved" | "rejected" | "superseded" | "assigned";
  actor: string | null; note: string | null;
}
interface Effect { id: string; state: "pending" | "completed"; snapshot: ReviewSnapshot; calendar: Record<string, unknown> | null }
export type ReviewerPolicy = Readonly<Record<string, readonly Purpose[]>>;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) throw new Error("Invalid text");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Invalid calendar date");
  return value;
}
export function draft(value: unknown): Draft {
  const data = object(value);
  return { releaseId: identifier(data.releaseId), date: date(data.date), title: text(data.title, 200), body: text(data.body, 4000) };
}
export function brief(value: unknown): Brief {
  const data = object(value);
  if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 8) throw new Error("One to eight sources required");
  const sources = data.sources.map(item => { const source = object(item); return { id: identifier(source.id), date: date(source.date) }; });
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Duplicate source IDs");
  return { releaseId: identifier(data.releaseId), title: text(data.title, 200), change: text(data.change, 1000), sources };
}
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const purposeFor = (mode: HumanMode): Purpose => ({ approval: "activate", intermediate: "intermediate", edit: "edit", publish: "publish", escalation: "handoff" })[mode] as Purpose;
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); await rename(temporary, path);
}
async function immutable(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== content) throw error; }
  } finally { await rm(temporary, { force: true }); }
}

export class HumanReviewStore {
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly reviewers: ReviewerPolicy;
  constructor(directory: string, reviewers: ReviewerPolicy) {
    this.directory = directory;
    this.reviewers = structuredClone(reviewers);
    this.db = new DatabaseSync(join(directory, "reviews.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(jobId TEXT,version INTEGER,data TEXT NOT NULL,PRIMARY KEY(jobId,version));
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,jobId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,jobId TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
    `);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = run(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private saveJob(job: HumanJob, kind: string, data: unknown = job): void {
    job.revision++;
    this.db.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(job), job.id);
    this.db.prepare("INSERT INTO events(jobId,kind,data) VALUES(?,?,?)").run(job.id, kind, JSON.stringify(data));
  }
  private saveRequest(request: ReviewRequest): void { this.db.prepare("UPDATE requests SET data=? WHERE id=?").run(JSON.stringify(request), request.id); }
  async create(id: string, mode: HumanMode): Promise<HumanJob> {
    identifier(id);
    if (!["approval", "intermediate", "edit", "publish", "escalation"].includes(mode)) throw new Error("Invalid human workflow");
    const source = brief(await readJson(join(this.directory, `${id}.source.json`)));
    const target = object(await readJson(join(this.directory, `${id}.deployment.json`)));
    if (target.releaseId !== source.releaseId || target.active !== false) throw new Error("Initial deployment must match the inactive release");
    const job: HumanJob = { schemaVersion: 1, id, mode, stage: "queued", revision: 0, source, sourceDigest: digest(source), targetBeforeDigest: digest(target), context: null,
      currentVersion: 0, gateId: null, reason: null, assignee: null };
    this.db.prepare("INSERT INTO jobs VALUES(?,?)").run(id, JSON.stringify(job)); return job;
  }
  job(id: string): HumanJob {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(identifier(id));
    if (!row) throw new Error("Unknown task");
    const job = JSON.parse(String(row.data)) as HumanJob;
    if (job.schemaVersion !== 1 || job.id !== id) throw new Error("Unsupported review schema");
    return job;
  }
  version(id: string, version = this.job(id).currentVersion): Version {
    const row = this.db.prepare("SELECT data FROM versions WHERE jobId=? AND version=?").get(identifier(id), version);
    if (!row) throw new Error("Unknown artifact version");
    const saved = JSON.parse(String(row.data)) as Version;
    if (saved.digest !== digest(draft(saved.draft))) throw new Error("Artifact digest mismatch");
    return saved;
  }
  request(id: string): ReviewRequest {
    const row = this.db.prepare("SELECT data FROM requests WHERE id=?").get(identifier(id));
    if (!row) throw new Error("Unknown review request");
    const request = JSON.parse(String(row.data)) as ReviewRequest;
    if (request.token !== digest(request.snapshot)) throw new Error("Review snapshot digest mismatch");
    return request;
  }
  private role(actor: string, purpose: Purpose): void {
    if (!actor.trim() || !this.reviewers[actor]?.includes(purpose)) throw new Error("Actor is not authorized for this review purpose");
  }
  private current(requestId: string, expectedToken: string): { job: HumanJob; request: ReviewRequest } {
    const request = this.request(requestId), job = this.job(request.taskId);
    if (request.token !== expectedToken || job.gateId !== request.id || request.snapshot.version !== job.currentVersion || !request.delivered || request.status !== "pending") throw new Error("Stale, undelivered or already decided review");
    if (job.currentVersion && request.snapshot.artifactDigest !== this.version(job.id).digest) throw new Error("Review does not match current artifact");
    return { job, request };
  }
  /** Called by the authenticated application controller, never registered as a model tool. */
  decide(input: { requestId: string; expectedToken: string; choice: "approve" | "reject"; actor: string; note?: string }): HumanJob {
    return this.transaction(() => {
      const { job, request } = this.current(input.requestId, input.expectedToken);
      if (request.snapshot.purpose === "handoff" || !["approve", "reject"].includes(input.choice)) throw new Error("A handoff requires human assignment, not automatic approval");
      this.role(input.actor, request.snapshot.purpose);
      request.status = input.choice === "approve" ? "approved" : "rejected"; request.actor = input.actor; request.note = input.note ?? null;
      job.stage = input.choice === "approve" ? "approved" : "rejected";
      this.saveRequest(request); this.saveJob(job, "human-decision", request); return job;
    });
  }
  /** Editing creates a new immutable version and invalidates any earlier review, including approval. */
  edit(input: { requestId: string; expectedToken: string; replacement: Draft; actor: string; note: string }): HumanJob {
    return this.transaction(() => {
      const request = this.request(input.requestId), job = this.job(request.taskId);
      if (!["edit", "publish"].includes(job.mode) || !["awaiting-review", "approved"].includes(job.stage) || job.gateId !== request.id
        || request.token !== input.expectedToken || !request.delivered || !["pending", "approved"].includes(request.status)) throw new Error("Artifact cannot be edited from this review");
      this.role(input.actor, request.snapshot.purpose); text(input.note, 1000);
      const replacement = draft(input.replacement);
      if (replacement.releaseId !== job.source.releaseId) throw new Error("Editing cannot change the operation's release ID");
      request.status = "superseded"; this.saveRequest(request);
      const version: Version = { version: job.currentVersion + 1, digest: digest(replacement), draft: replacement, author: input.actor };
      this.db.prepare("INSERT INTO versions VALUES(?,?,?)").run(job.id, version.version, JSON.stringify(version));
      job.currentVersion = version.version; job.stage = "drafted"; job.gateId = null;
      this.saveJob(job, "human-edit", { version, note: input.note, supersedes: request.id }); return job;
    });
  }
  claim(input: { requestId: string; expectedToken: string; actor: string; note: string }): HumanJob {
    return this.transaction(() => {
      const { job, request } = this.current(input.requestId, input.expectedToken);
      if (request.snapshot.purpose !== "handoff") throw new Error("Only escalated tasks may be claimed");
      this.role(input.actor, "handoff"); text(input.note, 1000);
      request.status = "assigned"; request.actor = input.actor; request.note = input.note;
      job.assignee = input.actor; this.saveRequest(request); this.saveJob(job, "human-handoff-claimed", request); return job;
    });
  }
  private gate(jobId: string, reason: string | null): ReviewRequest {
    return this.transaction(() => {
      const job = this.job(jobId);
      if (job.gateId) return this.request(job.gateId);
      if (!["queued", "drafted"].includes(job.stage)) throw new Error("Task cannot request a new review");
      const conflict = new Set(job.source.sources.map(source => source.date)).size > 1;
      const purpose = reason || conflict || job.mode === "escalation" ? "handoff" : purposeFor(job.mode);
      if (!job.currentVersion && purpose !== "handoff") throw new Error("Review requires a draft");
      const artifact = job.currentVersion ? this.version(job.id) : null;
      job.stage = purpose === "handoff" ? "escalated" : "awaiting-review"; job.reason = reason ?? (conflict ? "CONFLICTING_DATES" : purpose === "handoff" ? "HUMAN_REVIEW_REQUIRED" : null);
      const snapshot: ReviewSnapshot = { taskId: job.id, purpose, version: job.currentVersion, artifactDigest: artifact?.digest ?? null, proposal: artifact?.draft ?? null,
        sourceDigest: job.sourceDigest, operation: { kind: purpose === "activate" ? "activate-local-release" : purpose === "publish" ? "publish-local-notice" : purpose === "handoff" ? "human-handoff" : "create-private-calendar",
          target: purpose === "activate" ? `${job.id}.deployment.json` : purpose === "publish" ? `published/${job.id}.json` : purpose === "handoff" ? "human-inbox" : `private/${job.id}.ics`, beforeDigest: purpose === "activate" ? job.targetBeforeDigest : null },
        reason: job.reason, handoff: purpose === "handoff" ? { task: structuredClone(job), sources: job.source, context: job.context,
          events: this.db.prepare("SELECT seq,kind,data FROM events WHERE jobId=? ORDER BY seq").all(job.id).map(row => ({ seq: row.seq, kind: row.kind, data: JSON.parse(String(row.data)) })) } : null };
      const request: ReviewRequest = { id: randomUUID(), taskId: job.id, token: digest(snapshot), snapshot, delivered: false, status: "pending", actor: null, note: null };
      this.db.prepare("INSERT INTO requests VALUES(?,?,?)").run(request.id, job.id, JSON.stringify(request));
      job.gateId = request.id; this.saveJob(job, "review-requested", { requestId: request.id, token: request.token }); return request;
    });
  }
  private async apply(jobId: string, version: number, artifactDigest: string, calendar: Record<string, unknown> | null, signal?: AbortSignal): Promise<HumanJob> {
    signal?.throwIfAborted();
    const effect = this.transaction((): Effect => {
      const job = this.job(jobId);
      const existing = this.db.prepare("SELECT data FROM effects WHERE id=?").get(jobId);
      if (existing) {
        const saved = JSON.parse(String(existing.data)) as Effect;
        if (saved.snapshot.version !== version || saved.snapshot.artifactDigest !== artifactDigest) throw new Error("Effect version conflict");
        return saved;
      }
      if (job.stage !== "approved" || !job.gateId) throw new Error("Human approval required before effect execution");
      const request = this.request(job.gateId), current = this.version(job.id);
      if (request.status !== "approved" || !request.delivered || request.snapshot.purpose === "handoff" || request.snapshot.version !== version
        || job.currentVersion !== version || current.digest !== artifactDigest || request.snapshot.artifactDigest !== artifactDigest) throw new Error("Approval does not match the executable version");
      if (["intermediate", "edit"].includes(request.snapshot.purpose)) {
        if (!calendar || calendar.releaseId !== current.draft.releaseId || calendar.date !== current.draft.date || calendar.title !== current.draft.title || Object.keys(calendar).length !== 3) throw new Error("Calendar must use the human-confirmed version");
      } else if (calendar) throw new Error("Unexpected calendar payload");
      const saved: Effect = { id: job.id, state: "pending", snapshot: request.snapshot, calendar };
      this.db.prepare("INSERT INTO effects VALUES(?,?)").run(job.id, JSON.stringify(saved));
      job.stage = "executing"; this.saveJob(job, "effect-claimed", { version, artifactDigest }); return saved;
    });
    if (effect.state === "completed") return this.job(jobId);
    const content = effect.snapshot.proposal!;
    signal?.throwIfAborted();
    if (effect.snapshot.purpose === "activate") {
      const path = join(this.directory, `${jobId}.deployment.json`), actual = await readJson(path);
      const desired = { releaseId: content.releaseId, active: true, date: content.date, reviewToken: digest(effect.snapshot) };
      if (digest(actual) !== effect.snapshot.operation.beforeDigest && digest(actual) !== digest(desired)) throw new Error("Deployment changed since human review");
      await atomic(path, desired);
    } else {
      const folder = join(this.directory, effect.snapshot.purpose === "publish" ? "published" : "private"); await mkdir(folder, { recursive: true });
      const payload = { version: effect.snapshot.version, digest: effect.snapshot.artifactDigest, reviewToken: digest(effect.snapshot), content, ...(effect.calendar ? { calendar: effect.calendar } : {}) };
      await immutable(join(folder, `${jobId}.json`), JSON.stringify(payload, null, 2) + "\n");
      if (effect.snapshot.purpose === "publish") await immutable(join(folder, `${jobId}.md`), `# ${content.title}\n\n${content.body}\n\nRelease: ${content.releaseId}\nDate: ${content.date}\n`);
      else {
        const escaped = content.title.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
        const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ditto Examples//Human Review//EN", "BEGIN:VEVENT", `UID:${jobId}@ditto.example`, "DTSTAMP:20260101T000000Z", `DTSTART;VALUE=DATE:${content.date.replaceAll("-", "")}`, `SUMMARY:${escaped}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
        await immutable(join(folder, `${jobId}.ics`), ics);
      }
    }
    signal?.throwIfAborted();
    return this.transaction(() => {
      const job = this.job(jobId); effect.state = "completed";
      this.db.prepare("UPDATE effects SET data=? WHERE id=?").run(JSON.stringify(effect), jobId);
      job.stage = "completed"; this.saveJob(job, "effect-completed", { token: digest(effect.snapshot) }); return job;
    });
  }
  get tools(): RegisteredTool[] {
    const tool = (name: string, execute: RegisteredTool["execute"]): RegisteredTool => ({ name, effects: ["read", "write"], inputSchema: { type: "object", required: ["id"] }, validate(args) { identifier(args.id); }, execute });
    const ok = (value: unknown) => ({ status: "success" as const, structuredContent: json(value) });
    return [
      tool("human_read", async args => { const job = this.job(String(args.id)); return ok({ job, artifact: job.currentVersion ? this.version(job.id) : null, request: job.gateId ? this.request(job.gateId) : null }); }),
      tool("human_source", async args => {
        const job = this.job(String(args.id)), source = brief(await readJson(join(this.directory, `${job.id}.source.json`)));
        if (digest(source) !== job.sourceDigest) throw new Error("Source changed before generation");
        return ok({ source, sourceDigest: job.sourceDigest });
      }),
      tool("human_save_context", async args => ok(this.transaction(() => {
        const job = this.job(String(args.id)), context = object(args.context) as unknown as Context;
        if (job.stage !== "queued" || args.sourceDigest !== job.sourceDigest || !Array.isArray(context.items)) throw new Error("Context checkpoint conflict");
        job.context = context; this.saveJob(job, "context-prepared"); return job;
      }))),
      tool("human_save_draft", async args => ok(this.transaction(() => {
        const job = this.job(String(args.id)), content = draft(args.draft), context = object(args.context) as unknown as Context;
        if (job.stage !== "queued" || args.sourceDigest !== job.sourceDigest || !Array.isArray(context.items)) throw new Error("Draft checkpoint conflict");
        if (content.releaseId !== job.source.releaseId || content.date !== job.source.sources[0]!.date || content.title !== job.source.title || !content.body.includes(job.source.change)) throw new Error("Draft does not preserve the source facts");
        const artifact: Version = { version: 1, digest: digest(content), draft: content, author: "agent" };
        this.db.prepare("INSERT INTO versions VALUES(?,?,?)").run(job.id, 1, JSON.stringify(artifact));
        job.currentVersion = 1; job.context = context; job.stage = "drafted"; this.saveJob(job, "draft-generated", artifact); return job;
      }))),
      tool("human_request_review", async args => {
        const reason = args.reason === undefined || args.reason === null ? null : String(args.reason);
        if (reason && !["MODEL_INVALID", "MODEL_FAILED", "CONFLICTING_DATES", "HUMAN_REVIEW_REQUIRED"].includes(reason)) throw new Error("Unknown escalation reason");
        return ok(this.gate(String(args.id), reason));
      }),
      tool("human_apply", async (args, context) => {
        if (!Number.isSafeInteger(args.version) || Number(args.version) < 1 || typeof args.digest !== "string") throw new Error("Version and digest required");
        return ok(await this.apply(String(args.id), Number(args.version), args.digest, args.calendar === undefined || args.calendar === null ? null : object(args.calendar), context.signal));
      }),
      tool("human_report", async args => {
        const job = this.job(String(args.id)), directory = join(this.directory, "results"); await mkdir(directory, { recursive: true });
        const result = { job, artifact: job.currentVersion ? this.version(job.id) : null, request: job.gateId ? this.request(job.gateId) : null };
        await atomic(join(directory, `${job.id}.json`), result); return ok(result);
      }),
    ];
  }
  readonly output: OutputSink = { deliver: async input => {
    const request = this.request(input.deliveryId);
    const envelope = { requestId: request.id, token: request.token, snapshot: request.snapshot };
    if (digest(input.message.content) !== digest(envelope)) throw new Error("Review presentation does not match its saved snapshot");
    const directory = join(this.directory, "inbox"); await mkdir(directory, { recursive: true });
    await immutable(join(directory, `${request.id}.json`), JSON.stringify(envelope, null, 2) + "\n");
    await immutable(join(directory, `${request.id}.md`), `# ${request.snapshot.purpose} review\n\nTask: ${request.taskId}\nVersion: ${request.snapshot.version}\nRequest: ${request.id}\nToken: ${request.token}\n\n` + JSON.stringify(request.snapshot, null, 2) + "\n");
    this.transaction(() => { const latest = this.request(request.id); latest.delivered = true; this.saveRequest(latest); });
    return { deliveryId: input.deliveryId, status: "accepted", artifacts: [{ name: "review.json", reference: { uri: pathToFileURL(join(directory, `${request.id}.json`)).href, mediaType: "application/json" } }] };
  } };
  close(): void { this.db.close(); }
}
