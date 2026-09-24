import { DatabaseSync } from "node:sqlite";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "@ditto/core/contracts";
import type { OutputSink, RegisteredTool } from "@ditto/core/worker/interaction";
import type { PickupRecord } from "./pickup-ledger.ts";

function fingerprint(value: PickupRecord): string {
  return createHash("sha256").update(JSON.stringify({ code: value.code, quantity: value.quantity })).digest("hex");
}
export interface StoredTask {
  id: string; kind: string; status: string; risk: number | null; outcome: string | null;
}
/** A concrete example application's durable queue, ledger and delivery adapter, not a Core service. */
export class PickupTaskStore {
  readonly db: DatabaseSync;
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    this.db = new DatabaseSync(join(directory, "tasks.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, risk REAL, outcome TEXT);
      CREATE TABLE IF NOT EXISTS catalog(code TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pickups(id TEXT PRIMARY KEY, code TEXT NOT NULL, quantity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, actor TEXT NOT NULL, decision TEXT NOT NULL, fingerprint TEXT NOT NULL);
    `);
  }
  create(id: string, kind: string, risk?: number): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid task id");
    if (risk !== undefined && (!Number.isFinite(risk) || risk < 0 || risk > 100)) throw new Error("Invalid task risk");
    this.db.prepare("INSERT INTO tasks(id,kind,status,risk) VALUES(?,?,?,?)").run(id, kind, "queued", risk ?? null);
  }
  task(id: string): StoredTask {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new Error("Task not found");
    return row as unknown as StoredTask;
  }
  addReference(value: PickupRecord): void {
    this.db.prepare("INSERT INTO catalog VALUES(?,?)").run(value.code, value.quantity);
  }
  verify(value: PickupRecord): boolean {
    return this.db.prepare("SELECT quantity FROM catalog WHERE code=?").get(value.code)?.quantity === value.quantity;
  }
  async review(id: string, decision: "approve" | "reject", actor: string): Promise<void> {
    if (!actor.trim() || !["approve", "reject"].includes(decision)) throw new Error("Invalid review decision");
    const task = this.task(id);
    if (task.status !== "pending_confirmation" && task.status !== "pending_human") throw new Error("Task is not awaiting review");
    const content = JSON.parse(task.outcome!) as PickupRecord;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO reviews VALUES(?,?,?,?)").run(id, actor, decision, fingerprint(content));
      this.db.prepare("UPDATE tasks SET status=? WHERE id=?").run(decision === "approve" ? "approved" : "rejected", id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    await mkdir(join(this.directory, "reviews"), { recursive: true });
    await writeFile(join(this.directory, "reviews", `${id}.json`), JSON.stringify({ id, actor, decision, fingerprint: fingerprint(content) }, null, 2) + "\n");
    if (decision === "reject") await this.writeDelivery({ deliveryId: id, message: { role: "assistant", content: {
      ...JSON.parse(task.outcome!), status: "rejected",
    } } });
  }
  async fail(id: string, code: string): Promise<void> {
    await this.writeDelivery({ deliveryId: id, message: { role: "assistant", content: { route: "error", status: "failed", error: code } } });
  }
  authorized(id: string, value: PickupRecord): boolean {
    const task = this.task(id);
    const review = this.db.prepare("SELECT * FROM reviews WHERE id=?").get(id);
    return (task.status === "approved" || task.status === "completed") && review?.decision === "approve" && review.fingerprint === fingerprint(value);
  }
  pickup(id: string): PickupRecord | undefined {
    return this.db.prepare("SELECT code,quantity FROM pickups WHERE id=?").get(id) as PickupRecord | undefined;
  }
  readonly tool: RegisteredTool = {
    name: "record_pickup", effects: ["write"], inputSchema: {
      type: "object", required: ["id", "code", "quantity"], properties: {
        id: { type: "string" }, code: { type: "string" }, quantity: { type: "integer", minimum: 0 },
      }, additionalProperties: false,
    },
    validate(args) {
      if (typeof args.id !== "string" || !args.id.trim() || typeof args.code !== "string" || !args.code.trim()
        || typeof args.quantity !== "number" || !Number.isSafeInteger(args.quantity) || args.quantity < 0) throw new Error("Invalid pickup arguments");
    },
    execute: async args => {
      const id = String(args.id);
      const value = { code: String(args.code), quantity: Number(args.quantity) };
      const task = this.task(id);
      if (task.kind !== "risk" || task.risk === null || task.status === "rejected"
        || !(task.risk < 25 || (task.risk < 50 && this.verify(value)) || this.authorized(id, value))) throw new Error("Pickup is not authorized");
      const previous = this.pickup(id);
      if (previous && fingerprint(previous) !== fingerprint(value)) throw new Error("Conflicting pickup id");
      this.db.prepare("INSERT OR IGNORE INTO pickups VALUES(?,?,?)").run(id, value.code, value.quantity);
      return { status: "success", structuredContent: { id, ...value } };
    },
  };
  private async writeDelivery(input: Parameters<OutputSink["deliver"]>[0]): ReturnType<OutputSink["deliver"]> {
      this.task(input.deliveryId); // Only application-created tasks may receive artifacts.
      const content = input.message.content as JsonObject;
      if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Expected task content");
      const status = content.status === "pending_confirmation" || content.status === "pending_human" || content.status === "blocked" || content.status === "rejected" || content.status === "failed"
        ? content.status : "completed";
      const artifact = join(this.directory, "deliveries", `${input.deliveryId}.json`);
      await mkdir(join(this.directory, "deliveries"), { recursive: true });
      const temporary = `${artifact}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ taskId: input.deliveryId, status, content }, null, 2) + "\n");
      await rename(temporary, artifact);
      this.db.prepare("UPDATE tasks SET status=?,outcome=? WHERE id=?").run(status, JSON.stringify(content), input.deliveryId);
      return { deliveryId: input.deliveryId, status: "accepted", artifacts: [{ name: "task-result.json", reference: { uri: pathToFileURL(artifact).href, mediaType: "application/json" } }] };
  }
  readonly output: OutputSink = { deliver: input => this.writeDelivery(input) };
  close(): void { this.db.close(); }
}
