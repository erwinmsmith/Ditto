import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject, JsonValue } from "@ditto/core/contracts";
import type { OutputSink, RegisteredTool } from "@ditto/core/worker/interaction";

export interface OrderRecord { code: string; quantity: number; unitPriceCents: number }
export interface SavedOrder extends OrderRecord { sourceId: string; sourceSha256: string; totalCents: number }
export interface OrderFailure { sourceId: string; code: string; message: string }
export interface OrderReport {
  batchId: string; status: "completed" | "partial" | "failed";
  successes: SavedOrder[]; failures: OrderFailure[];
  totals: { orders: number; quantity: number; totalCents: number };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
export function orderRecord(value: unknown): OrderRecord {
  const data = object(value);
  if (typeof data.code !== "string" || !data.code.trim() || typeof data.quantity !== "number"
    || !Number.isSafeInteger(data.quantity) || data.quantity < 1 || typeof data.unitPriceCents !== "number"
    || !Number.isSafeInteger(data.unitPriceCents) || data.unitPriceCents < 0
    || !Number.isSafeInteger(data.quantity * data.unitPriceCents)) throw new Error("Invalid order record");
  return { code: data.code, quantity: data.quantity, unitPriceCents: data.unitPriceCents };
}
export async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }

class ArtifactConflict extends Error {}

/** Atomically publish an immutable artifact. Identical retries succeed; conflicting writes fail. */
async function persist(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(temporary, text, { flag: "wx" });
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(path, "utf8") !== text) throw new ArtifactConflict("Artifact write conflict");
    }
  } finally { await rm(temporary, { force: true }); }
}
function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

/** Application-owned filesystem integration; no vendor or business configuration enters Core. */
export function createOrderFiles(options: { inputDirectory: string; outputDirectory: string }) {
  const outputDirectory = resolve(options.outputDirectory);
  const batchDirectory = (id: string) => join(outputDirectory, identifier(id));
  const pathFor = (id: string, sourceId: string) => join(batchDirectory(id), `${identifier(sourceId)}.order.json`);
  const tools: RegisteredTool[] = [
    {
      name: "read_order_source", effects: ["read"], inputSchema: { type: "object", required: ["sourceId", "path"], properties: { sourceId: { type: "string" }, path: { type: "string" } } },
      validate(args) { identifier(args.sourceId); if (typeof args.path !== "string" || !args.path.trim()) throw new Error("Source path required"); },
      async execute(args) {
        const root = await realpath(options.inputDirectory);
        let path: string;
        try { path = await realpath(String(args.path)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "failed", error: { code: "SOURCE_NOT_FOUND", message: "Order source was not found" } };
          throw error;
        }
        const rel = relative(root, path);
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("Source outside input directory");
        const info = await stat(path);
        if (!info.isFile() || info.size > 1024 * 1024) return { status: "failed", error: { code: "INVALID_SOURCE", message: "Order source must be a regular file of at most one MiB" } };
        const bytes = await readFile(path);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.trim()) return { status: "failed", error: { code: "EMPTY_SOURCE", message: "Order source is empty" } };
        return { status: "success", structuredContent: { sourceId: args.sourceId!, text, sourceSha256: createHash("sha256").update(bytes).digest("hex") } };
      },
    },
    {
      name: "save_order", effects: ["write"], inputSchema: { type: "object", required: ["batchId", "sourceId", "sourceSha256", "record"] },
      validate(args) {
        identifier(args.batchId); identifier(args.sourceId); orderRecord(args.record);
        if (typeof args.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sourceSha256)) throw new Error("Invalid source digest");
      },
      async execute(args) {
        const record = orderRecord(args.record);
        const saved: SavedOrder = { sourceId: String(args.sourceId), sourceSha256: String(args.sourceSha256), ...record, totalCents: record.quantity * record.unitPriceCents };
        await mkdir(batchDirectory(String(args.batchId)), { recursive: true });
        try { await persist(pathFor(String(args.batchId), saved.sourceId), saved); }
        catch (error) {
          if (error instanceof ArtifactConflict) return { status: "failed", error: { code: "ARTIFACT_CONFLICT", message: "An existing order artifact differs from this result" } };
          throw error;
        }
        return { status: "success", structuredContent: jsonValue(saved) };
      },
    },
    {
      name: "save_parallel_plan", effects: ["write"], inputSchema: { type: "object", required: ["batchId", "plan"] },
      validate(args) { identifier(args.batchId); object(args.plan); },
      async execute(args) {
        const directory = batchDirectory(String(args.batchId));
        await mkdir(directory, { recursive: true });
        await persist(join(directory, "plan.json"), args.plan);
        return { status: "success", structuredContent: args.plan! };
      },
    },
    {
      name: "build_order_report", effects: ["read", "write"], inputSchema: { type: "object", required: ["batchId", "successIds", "failures"] },
      validate(args) {
        identifier(args.batchId);
        if (!Array.isArray(args.successIds) || !Array.isArray(args.failures)) throw new Error("Expected result arrays");
        const ids = args.successIds.map(identifier);
        for (const failure of args.failures) {
          const value = object(failure); ids.push(identifier(value.sourceId));
          if (typeof value.code !== "string" || !/^[A-Z_]{1,64}$/.test(value.code) || typeof value.message !== "string" || !value.message.trim()) throw new Error("Invalid failure details");
        }
        if (new Set(ids).size !== ids.length) throw new Error("Duplicate or overlapping result IDs");
      },
      async execute(args) {
        const batchId = String(args.batchId);
        const successes: SavedOrder[] = [];
        for (const id of args.successIds as readonly string[]) {
          const stored = object(await readJson(pathFor(batchId, id)));
          const record = orderRecord(stored);
          if (stored.sourceId !== id || typeof stored.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(stored.sourceSha256)
            || stored.totalCents !== record.quantity * record.unitPriceCents) throw new Error("Invalid persisted order");
          successes.push({ sourceId: id, sourceSha256: stored.sourceSha256, ...record, totalCents: stored.totalCents });
        }
        const failures = args.failures as unknown as OrderFailure[];
        const quantity = successes.reduce((sum, item) => sum + item.quantity, 0);
        const totalCents = successes.reduce((sum, item) => sum + item.totalCents, 0);
        if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(totalCents)) throw new Error("Report totals exceed safe integers");
        const report: OrderReport = { batchId, status: failures.length ? successes.length ? "partial" : "failed" : "completed",
          successes, failures, totals: { orders: successes.length, quantity, totalCents } };
        const directory = batchDirectory(batchId);
        await mkdir(directory, { recursive: true });
        await persist(join(directory, "report.json"), report);
        return { status: "success", structuredContent: jsonValue(report) };
      },
    },
  ];
  const output: OutputSink = { async deliver(input) {
    const id = identifier(input.deliveryId);
    const report = await readJson(join(batchDirectory(id), "report.json"));
    if (JSON.stringify(report) !== JSON.stringify(input.message.content)) throw new Error("Delivery does not match the persisted report");
    const path = join(batchDirectory(id), "delivery.json");
    await persist(path, { deliveryId: id, report });
    return { deliveryId: id, status: "accepted", artifacts: [{ name: "order-report.json", reference: { uri: pathToFileURL(path).href, mediaType: "application/json" } }] };
  } };
  return { tools, output, batchDirectory, pathFor };
}
export function toJsonObject(value: unknown): JsonObject { return object(jsonValue(value)) as JsonObject; }
