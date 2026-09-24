import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { json, object } from "../evidence.ts";
import {
  request,
  invoices,
  batch,
  reviews,
  receipt,
  checkpoint,
  idOf,
  type Request,
  type Invoice,
  type Receipt,
  type Checkpoint,
  type Report,
} from "./domain.ts";
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export type Scenario = "mixed" | "matched" | "empty";
export async function createDemo(
  directory: string,
  overrides: Partial<Omit<Request, "sourceDigest" | "protocol">> = {},
  scenario: Scenario = "mixed",
) {
  if (!["mixed", "matched", "empty"].includes(scenario))
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const rows: Invoice[] =
    scenario === "empty"
      ? []
      : Array.from({ length: 6 }, (_, n) => ({
          id: `INV-${101 + n}`,
          vendor: `Supplier ${n + 1}`,
          invoiceCents:
            10000 * (n + 1) + (scenario === "mixed" && n === 2 ? 2000 : 0),
          purchaseOrderCents: 10000 * (n + 1),
          received: !(scenario === "mixed" && n === 4),
          note: "Review the invoice against the purchase order and receiving record. This is a review, not payment authorization.",
        }));
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    goal: "分批审核发票与采购订单及收货记录，标注差异和待补资料，保存审核结果及可恢复进度，交付审核清单。",
    batchSize: 2,
    maxModelCalls: 12,
    maxAttempts: 2,
    deadlineSeconds: 600,
    ...overrides,
    sourceDigest: idOf(rows),
    protocol: 1,
  });
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(join(directory, "invoices.json"), JSON.stringify(rows));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  const db = new DatabaseSync(join(directory, "reviews.sqlite"));
  try {
    db.exec(
      "CREATE TABLE task(id INTEGER PRIMARY KEY CHECK(id=1), request_digest TEXT NOT NULL); CREATE TABLE receipts(batch_id TEXT PRIMARY KEY, start_index INTEGER UNIQUE NOT NULL, body TEXT NOT NULL); CREATE TABLE reviews(invoice_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE audit(batch_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO task VALUES(1,?)").run(idOf(r));
  } finally {
    db.close();
  }
  return r;
}
export class LongTaskAdapters {
  readonly directory: string;
  readonly request: Request;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
  }
  async load() {
    const r = request(
        JSON.parse(await file(join(this.directory, "request.json"))),
      ),
      p = object(JSON.parse(await file(join(this.directory, "policy.json"))));
    if (!isDeepStrictEqual(r, this.request))
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Permission revoked");
    const rows = invoices(
      JSON.parse(await file(join(this.directory, "invoices.json"))),
    );
    if (idOf(rows) !== r.sourceDigest) throw new Error("Source changed");
    return rows;
  }
  private connect() {
    const db = new DatabaseSync(join(this.directory, "reviews.sqlite"));
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }
  private ledger(db: DatabaseSync, rows: Invoice[]): Receipt[] {
    if (
      db.prepare("SELECT request_digest FROM task WHERE id=1").get()
        ?.request_digest !== idOf(this.request)
    )
      throw new Error("Business database scope mismatch");
    const saved = db
      .prepare(
        "SELECT batch_id,start_index,body FROM receipts ORDER BY start_index",
      )
      .all();
    let cursor = 0,
      previousId: string | null = null;
    const receipts: Receipt[] = [];
    for (const row of saved) {
      const got = JSON.parse(String(row.body)) as Receipt,
        b = batch(this.request, rows, cursor);
      if (!b.items.length) throw new Error("Extra receipt");
      const expected = receipt(
        this.request,
        b,
        reviews({ batchId: b.id, reviews: got.reviews }, b),
        previousId,
      );
      if (
        !isDeepStrictEqual(got, expected) ||
        row.batch_id !== b.id ||
        row.start_index !== b.start
      )
        throw new Error("Receipt chain changed");
      receipts.push(got);
      previousId = got.id;
      cursor = b.end;
    }
    const stored = db
        .prepare(
          "SELECT invoice_id,batch_id,body FROM reviews ORDER BY invoice_id",
        )
        .all(),
      expected = receipts
        .flatMap((r) =>
          r.reviews.map((v) => ({
            invoice_id: v.invoiceId,
            batch_id: r.batchId,
            body: JSON.stringify(v),
          })),
        )
        .sort((a, b) => a.invoice_id.localeCompare(b.invoice_id));
    if (JSON.stringify(stored) !== JSON.stringify(expected))
      throw new Error("Business rows disagree with receipts");
    const audit = db
        .prepare("SELECT batch_id,receipt_id FROM audit ORDER BY batch_id")
        .all(),
      expectedAudit = receipts
        .map((r) => ({ batch_id: r.batchId, receipt_id: r.id }))
        .sort((a, b) => a.batch_id.localeCompare(b.batch_id));
    if (JSON.stringify(audit) !== JSON.stringify(expectedAudit))
      throw new Error("Business audit disagrees with receipts");
    return receipts;
  }
  async snapshot() {
    const rows = await this.load(),
      db = this.connect();
    try {
      return { rows, receipts: this.ledger(db, rows) };
    } finally {
      db.close();
    }
  }
  async reconcile(c: Checkpoint) {
    const { rows, receipts } = await this.snapshot();
    checkpoint(c, this.request, rows);
    if (
      c.receipts.length > receipts.length ||
      receipts.length > c.receipts.length + 1 ||
      c.receipts.some((r, i) => !isDeepStrictEqual(r, receipts[i]))
    )
      throw new Error("Checkpoint and database cannot be reconciled");
    return {
      receipts,
      cursor: receipts.at(-1)?.end ?? 0,
      recovered: receipts.length - c.receipts.length,
    };
  }
  async commit(start: number, proposal: unknown): Promise<Receipt> {
    const rows = await this.load(),
      b = batch(this.request, rows, start),
      result = reviews(proposal, b);
    if (!b.items.length) throw new Error("Empty batch cannot commit");
    const db = this.connect();
    try {
      db.exec("BEGIN IMMEDIATE");
      const history = this.ledger(db, rows),
        existing = history.find((x) => x.batchId === b.id);
      if (existing) {
        if (!isDeepStrictEqual(existing.reviews, result))
          throw new Error("Idempotency conflict");
        db.exec("COMMIT");
        return existing;
      }
      if ((history.at(-1)?.end ?? 0) !== start)
        throw new Error("Out-of-order commit");
      const saved = receipt(
        this.request,
        b,
        result,
        history.at(-1)?.id ?? null,
      );
      for (const v of result)
        db.prepare("INSERT INTO reviews VALUES(?,?,?)").run(
          v.invoiceId,
          b.id,
          JSON.stringify(v),
        );
      db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
        b.id,
        start,
        JSON.stringify(saved),
      );
      db.prepare("INSERT INTO audit VALUES(?,?)").run(b.id, saved.id);
      db.exec("COMMIT");
      return saved;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    } finally {
      db.close();
    }
  }
  async verify(out: Report) {
    const { rows, receipts } = await this.snapshot();
    if (
      out.requestId !== this.request.id ||
      out.total !== rows.length ||
      out.cursor !== (receipts.at(-1)?.end ?? 0) ||
      !isDeepStrictEqual(out.receipts, receipts)
    )
      throw new Error("Report disagrees with business database");
    if (out.status === "completed" && out.cursor !== rows.length)
      throw new Error("Incomplete task cannot complete");
  }
  get tools(): RegisteredTool[] {
    const ok = (v: unknown) => ({
      status: "success" as const,
      structuredContent: json(v),
    });
    const tool = (
      name: string,
      run: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: ["read", "write"],
      inputSchema: { type: "object" },
      validate: object,
      execute: async (a, c) => {
        c.signal?.throwIfAborted();
        await this.load();
        return run(a, c);
      },
    });
    return [
      tool("long_load", async () => ok(await this.snapshot())),
      tool("long_reconcile", async (a) =>
        ok(await this.reconcile(a.checkpoint as unknown as Checkpoint)),
      ),
      tool("long_batch", async (a) => {
        const { rows, receipts } = await this.snapshot();
        if (a.start !== (receipts.at(-1)?.end ?? 0))
          throw new Error("Batch cursor changed");
        return ok(batch(this.request, rows, Number(a.start)));
      }),
      tool("long_validate", async (a) => {
        const rows = await this.load();
        let validated;
        try {
          const b = batch(this.request, rows, Number(a.start));
          validated = { batchId: b.id, reviews: reviews(a.proposal, b) };
        } catch (e) {
          return {
            status: "failed",
            error: {
              code: "INVALID_REVIEW",
              message: e instanceof Error ? e.message : String(e),
            },
          };
        }
        return ok(validated);
      }),
      tool("long_commit", async (a) =>
        ok(await this.commit(Number(a.start), a.proposal)),
      ),
      tool("long_publish", async (a) => {
        const out = a.report as unknown as Report;
        await this.verify(out);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const lines = [
            "# Invoice review",
            `Status: ${out.status}`,
            `Stop: ${out.stopReason}`,
            `Progress: ${out.cursor}/${out.total}`,
          ],
          csv = ["invoice_id,disposition,variance_cents,batch_id"];
        for (const receipt of out.receipts)
          for (const r of receipt.reviews) {
            lines.push(
              `## ${r.invoiceId}`,
              r.summary,
              `Disposition: ${r.disposition}; variance: ${r.varianceCents} cents`,
              r.nextAction,
              r.quote,
              `Receipt: ${receipt.id}`,
            );
            csv.push(
              [
                r.invoiceId,
                r.disposition,
                r.varianceCents,
                receipt.batchId,
              ].join(","),
            );
          }
        await immutable(join(dir, "report.md"), lines.join("\n\n") + "\n");
        await immutable(join(dir, "reviews.csv"), csv.join("\n") + "\n");
        return ok({ directory: dir, cursor: out.cursor });
      }),
    ];
  }
}
