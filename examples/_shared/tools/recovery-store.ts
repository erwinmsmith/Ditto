/** Application task checkpoints and HTTP tool configuration; no Core persistence extension. */
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, JsonObject } from "@ditto/core/contracts";
import type { RegisteredTool, ToolExecutionOutcome } from "@ditto/core/worker/interaction";
import type { WorkerContext } from "@ditto/core/worker/node";
import { hash, identifier, object, operationFingerprint, order, type Operation, type OperationKind, type Order } from "./fulfillment-service.ts";

export type Stage = "queued" | "prepared" | "reserved" | "completed" | "paused" | "approved" | "rejected" | "timed-out" | "compensated" | "needs-review" | "uncertain" | "failed";
export interface Job {
  schemaVersion: 1; id: string; revision: number; stage: Stage; sourceHash: string;
  order: Order | null; context: Context | null; reservation: Record<string, unknown> | null; shipment: Record<string, unknown> | null;
  approval: { actor: string; decision: "approve" | "reject"; fingerprint: string } | null;
  requiresApproval: boolean; selectedSource: string | null; error: string | null;
}
export const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const success = (value: unknown): ToolExecutionOutcome => ({ status: "success", structuredContent: json(value) });
const failure = (code: string, retryable = false, metadata?: JsonObject): ToolExecutionOutcome => ({ status: "failed", error: { code, message: code, retryable }, ...(metadata ? { metadata } : {}) });
export const operationKey = (id: string, kind: OperationKind) => `${identifier(id)}-${kind}`;
export function validateOperation(value: unknown, job: Job, kind: OperationKind): Operation {
  const data = object(value);
  if (!["absent", "pending", "committed", "rejected"].includes(String(data.state))) throw new Error("Invalid remote operation state");
  if (data.state === "absent") return { state: "absent" };
  if (!job.order || data.fingerprint !== operationFingerprint(kind, job.order, operationKey(job.id, "reserve"))) throw new Error("Remote operation fingerprint conflict");
  if (data.state === "committed") {
    const result = object(data.result);
    if (kind !== "release" && hash(order(result)) !== hash(job.order)) throw new Error("Remote receipt does not match the order");
    if (result.reservationKey !== operationKey(job.id, "reserve")) throw new Error("Remote reservation key mismatch");
    if (kind === "ship" && result.shipmentKey !== operationKey(job.id, "ship")) throw new Error("Remote shipment key mismatch");
    if (kind === "release" && result.status !== "released") throw new Error("Remote release was not confirmed");
  }
  return data as unknown as Operation;
}
export class RecoveryStore {
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly serviceUrl: string;
  constructor(directory: string, serviceUrl: string) {
    this.directory = directory;
    const url = new URL(serviceUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") throw new Error("Provide a service origin without credentials or path");
    this.serviceUrl = url.origin;
    this.db = new DatabaseSync(join(directory, "tasks.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
    `);
  }
  async create(id: string, requiresApproval = false): Promise<Job> {
    identifier(id);
    if (id.length > 64) throw new Error("Task IDs must fit stable operation keys");
    const source = await readFile(join(this.directory, `${id}.txt`), "utf8");
    const job: Job = { schemaVersion: 1, id, revision: 0, stage: "queued", sourceHash: hash(source), order: null, context: null,
      reservation: null, shipment: null, approval: null, requiresApproval, selectedSource: null, error: null };
    this.db.prepare("INSERT INTO jobs VALUES(?,?)").run(id, JSON.stringify(job));
    this.event(id, "created", { sourceHash: job.sourceHash });
    return job;
  }
  job(id: string): Job {
    const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(identifier(id));
    if (!row) throw new Error("Unknown task");
    const job = JSON.parse(String(row.data)) as Job;
    if (job.schemaVersion !== 1 || job.id !== id) throw new Error("Unsupported checkpoint schema");
    return job;
  }
  event(id: string, kind: string, value: unknown): void {
    this.db.prepare("INSERT INTO events(id,kind,data) VALUES(?,?,?)").run(id, kind, JSON.stringify(value));
  }
  private update(id: string, kind: string, change: (job: Job) => void): Job {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.job(id); change(job); job.revision++;
      this.db.prepare("UPDATE jobs SET data=? WHERE id=?").run(JSON.stringify(job), id);
      this.event(id, kind, job); this.db.exec("COMMIT"); return job;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  decide(id: string, decision: "approve" | "reject", actor: string): Job {
    if (!["approve", "reject"].includes(decision) || !actor.trim()) throw new Error("A decision and authenticated actor are required");
    return this.update(id, "decision", job => {
      if (job.stage !== "paused" || !job.order) throw new Error("Task is not awaiting a decision");
      job.approval = { actor, decision, fingerprint: hash(job.order) };
      job.stage = decision === "approve" ? "approved" : "rejected";
    });
  }
  private authorize(job: Job): void {
    if (!job.order || (job.requiresApproval && (!job.approval || job.approval.decision !== "approve" || job.approval.fingerprint !== hash(job.order)))) throw new Error("Order execution is not authorized");
  }
  private async request(path: string, context: WorkerContext, body?: unknown): Promise<{ status: number; data: unknown }> {
    context.services.sandbox.assert("network", this.serviceUrl);
    const response = await fetch(this.serviceUrl + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error("Service response exceeds limit");
    return { status: response.status, data: JSON.parse(text) };
  }
  get tools(): RegisteredTool[] {
    const tool = (name: string, effects: RegisteredTool["effects"], execute: (args: JsonObject, context: WorkerContext) => Promise<ToolExecutionOutcome>): RegisteredTool => ({
      name, inputSchema: { type: "object", required: ["id"] }, ...(effects ? { effects } : {}),
      validate(args) { identifier(args.id); }, execute,
    });
    return [
      tool("recovery_read", ["read"], async args => success(this.job(String(args.id)))),
      tool("recovery_source", ["read"], async args => {
        const job = this.job(String(args.id));
        if (!Number.isSafeInteger(args.maxBytes) || Number(args.maxBytes) < 1 || Number(args.maxBytes) > 65536) throw new Error("Invalid source byte limit");
        let text: string;
        try { text = await readFile(join(this.directory, `${job.id}.txt`), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure("SOURCE_NOT_FOUND"); throw error; }
        const bytes = Buffer.byteLength(text);
        this.event(job.id, "source-read", { maxBytes: args.maxBytes, bytes });
        if (hash(text) !== job.sourceHash) return failure("SOURCE_CHANGED");
        if (bytes > Number(args.maxBytes)) return failure("SOURCE_TOO_LARGE", bytes <= 65536, { requiredBytes: bytes });
        if (!text.trim()) return failure("EMPTY_SOURCE");
        return success({ text, sourceHash: job.sourceHash });
      }),
      tool("recovery_prepare", ["write"], async args => {
        const value = order(args.order), context = object(args.context) as unknown as Context;
        if (!Array.isArray(context.items)) throw new Error("Context items required");
        const job = this.update(String(args.id), "prepared", job => {
          if (job.stage !== "queued" || args.sourceHash !== job.sourceHash) throw new Error("Preparation checkpoint conflict");
          job.order = value; job.context = context; job.stage = "prepared";
        });
        return success(job);
      }),
      tool("recovery_catalog", ["read", "network"], async (args, context) => {
        const job = this.job(String(args.id));
        if (!job.order || !["primary", "backup"].includes(String(args.source))) throw new Error("Prepared order and allowed source required");
        try {
          const result = await this.request(`/catalog/${args.source}?sku=${encodeURIComponent(job.order.sku)}`, context);
          this.event(job.id, "catalog", { source: args.source, status: result.status });
          if (result.status !== 200) return failure(result.status === 503 ? "UNAVAILABLE" : String(object(result.data).code ?? "CATALOG_FAILED"));
          const data = object(result.data);
          if (data.sku !== job.order.sku || typeof data.available !== "number" || !Number.isSafeInteger(data.available) || data.available < job.order.quantity) return failure("INSUFFICIENT_STOCK");
          return success(this.update(job.id, "catalog-selected", current => { current.selectedSource = String(args.source); }));
        } catch (error) { context.signal?.throwIfAborted(); if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) return failure("UNAVAILABLE"); throw error; }
      }),
      tool("recovery_operation", ["read", "write", "network"], async (args, context) => {
        const job = this.job(String(args.id)), kind = String(args.kind) as OperationKind;
        if (!job.order || !["reserve", "ship", "release"].includes(kind) || typeof args.apply !== "boolean") throw new Error("Invalid operation request");
        if (args.apply) {
          this.authorize(job);
          const allowed = kind === "reserve" ? ["prepared", "approved", "uncertain", "timed-out"] : ["reserved", "uncertain", "needs-review"];
          if (!allowed.includes(job.stage) || (kind !== "reserve" && !job.reservation)) throw new Error("Operation is not allowed in the current stage");
        }
        const key = operationKey(job.id, kind);
        this.event(job.id, args.apply ? "operation-write" : "operation-lookup", { kind, key });
        try {
          const response = await this.request(args.apply ? `/${kind}` : `/operations/${key}`, context,
            args.apply ? { key, order: job.order, reservationKey: operationKey(job.id, "reserve") } : undefined);
          if (![200, 202, 422].includes(response.status)) return args.apply
            ? { status: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Reconcile the stable operation key before retrying" } }
            : failure("LOOKUP_UNAVAILABLE");
          return success(validateOperation(response.data, job, kind));
        } catch (error) {
          context.signal?.throwIfAborted();
          if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) return args.apply ? { status: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Reconcile the stable operation key before retrying" } } : failure("LOOKUP_UNAVAILABLE");
          throw error;
        }
      }),
      tool("recovery_checkpoint", ["write"], async args => {
        const kind = String(args.kind) as OperationKind;
        if (!["reserve", "ship", "release"].includes(kind)) throw new Error("Invalid checkpoint kind");
        return success(this.update(String(args.id), `checkpoint-${kind}`, job => {
          const operation = validateOperation(args.operation, job, kind);
          if (operation.state !== "committed") throw new Error("A committed remote receipt is required");
          this.authorize(job);
          if (kind === "reserve") {
            if (job.stage === "completed" || job.stage === "compensated") return;
            job.reservation = operation.result!; job.stage = "reserved";
          } else if (kind === "ship") {
            if (!job.reservation || job.stage === "compensated") throw new Error("Invalid shipment checkpoint");
            job.shipment = operation.result!; job.stage = "completed";
          } else {
            if (job.shipment) throw new Error("A shipped task cannot be compensated by releasing stock");
            job.stage = "compensated";
          }
          if (kind !== "release") job.error = null;
        }));
      }),
      tool("recovery_state", ["write"], async args => {
        const stage = String(args.stage) as Stage;
        if (!["paused", "timed-out", "uncertain", "needs-review", "failed"].includes(stage)) throw new Error("Invalid application transition");
        return success(this.update(String(args.id), stage, job => {
          if (["completed", "compensated", "rejected"].includes(job.stage)) throw new Error("Terminal task cannot transition");
          if (stage === "paused") {
            if (job.stage !== "prepared" || !job.requiresApproval) throw new Error("Task does not require approval");
          }
          job.stage = stage; job.error = typeof args.error === "string" ? args.error : null;
        }));
      }),
      tool("recovery_context", ["write"], async args => {
        const context = object(args.context) as unknown as Context;
        if (!Array.isArray(context.items)) throw new Error("Context items required");
        const job = this.update(String(args.id), "session-context", current => { current.context = context; });
        return success({ job, answer: args.answer });
      }),
      tool("recovery_report", ["read", "write"], async args => {
        const job = this.job(String(args.id));
        const output = join(this.directory, "results"); await mkdir(output, { recursive: true });
        const path = join(output, `${job.id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(job, null, 2) + "\n"); await rename(temporary, path);
        return success(job);
      }),
    ];
  }
  close(): void { this.db.close(); }
}
