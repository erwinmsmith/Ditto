import { isDeepStrictEqual } from "node:util";
import { digest, identifier, object, text } from "../evidence.ts";
export const protocol = 1;
export const idOf = (v: unknown) => digest(JSON.stringify(v));
export function hash(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v))
    throw new Error("Invalid digest");
  return v;
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("Invalid number");
  return Number(v);
}
export interface Request {
  id: string;
  tenant: string;
  principal: string;
  goal: string;
  sourceDigest: string;
  batchSize: number;
  maxModelCalls: number;
  maxAttempts: number;
  deadlineSeconds: number;
  protocol: number;
}
export function request(v: unknown): Request {
  const r = object(v);
  if (r.protocol !== protocol) throw new Error("Unsupported protocol");
  return {
    id: identifier(r.id),
    tenant: identifier(r.tenant),
    principal: identifier(r.principal),
    goal: text(r.goal, 2000),
    sourceDigest: hash(r.sourceDigest),
    batchSize: integer(r.batchSize, 1, 10),
    maxModelCalls: integer(r.maxModelCalls, 1, 60),
    maxAttempts: integer(r.maxAttempts, 1, 3),
    deadlineSeconds: integer(r.deadlineSeconds, 1, 86400),
    protocol,
  };
}
export interface Invoice {
  id: string;
  vendor: string;
  invoiceCents: number;
  purchaseOrderCents: number;
  received: boolean;
  note: string;
}
export function invoices(v: unknown): Invoice[] {
  if (!Array.isArray(v) || v.length > 30)
    throw new Error("Invalid invoice input");
  const rows = v.map((x) => {
    const r = object(x);
    if (typeof r.received !== "boolean")
      throw new Error("Invalid receiving evidence");
    return {
      id: identifier(r.id),
      vendor: text(r.vendor, 100),
      invoiceCents: integer(r.invoiceCents, 0, 100000000),
      purchaseOrderCents: integer(r.purchaseOrderCents, 0, 100000000),
      received: r.received,
      note: text(r.note, 1000),
    };
  });
  if (new Set(rows.map((x) => x.id)).size !== rows.length)
    throw new Error("Duplicate invoice");
  return rows;
}
export const fact = (i: Invoice) =>
  `${i.id}: invoice=${i.invoiceCents} cents; purchase-order=${i.purchaseOrderCents} cents; received=${i.received}.`;
export type Disposition = "matched" | "amount-mismatch" | "awaiting-receipt";
export const disposition = (i: Invoice): Disposition =>
  !i.received
    ? "awaiting-receipt"
    : i.invoiceCents !== i.purchaseOrderCents
      ? "amount-mismatch"
      : "matched";
export interface Review {
  invoiceId: string;
  disposition: Disposition;
  varianceCents: number;
  summary: string;
  nextAction: string;
  quote: string;
}
export interface Batch {
  id: string;
  start: number;
  end: number;
  items: Invoice[];
}
export function batch(r: Request, rows: Invoice[], start: number): Batch {
  integer(start, 0, rows.length);
  if (start % r.batchSize !== 0) throw new Error("Invalid batch boundary");
  const end = Math.min(start + r.batchSize, rows.length);
  return {
    id: idOf({ requestDigest: idOf(r), start, end }),
    start,
    end,
    items: rows.slice(start, end),
  };
}
export function reviews(v: unknown, b: Batch): Review[] {
  const o = object(v);
  if (
    o.batchId !== b.id ||
    !Array.isArray(o.reviews) ||
    o.reviews.length !== b.items.length
  )
    throw new Error("Incomplete or stale batch");
  return b.items.map((i) => {
    const matches = (o.reviews as unknown[])
      .map(object)
      .filter((x) => x.invoiceId === i.id);
    if (matches.length !== 1)
      throw new Error("Missing or duplicate invoice review");
    const x = matches[0]!;
    if (
      x.disposition !== disposition(i) ||
      x.varianceCents !== i.invoiceCents - i.purchaseOrderCents ||
      x.quote !== fact(i)
    )
      throw new Error("Review contradicts source evidence");
    return {
      invoiceId: i.id,
      disposition: disposition(i),
      varianceCents: i.invoiceCents - i.purchaseOrderCents,
      summary: text(x.summary, 1200),
      nextAction: text(x.nextAction, 1000),
      quote: fact(i),
    };
  });
}
export interface Receipt {
  id: string;
  requestDigest: string;
  batchId: string;
  start: number;
  end: number;
  previousId: string | null;
  reviews: Review[];
}
export function receipt(
  r: Request,
  b: Batch,
  result: Review[],
  previousId: string | null,
): Receipt {
  const value = {
    requestDigest: idOf(r),
    batchId: b.id,
    start: b.start,
    end: b.end,
    previousId,
    reviews: result,
  };
  return { id: idOf(value), ...value };
}
export interface Checkpoint {
  protocol: number;
  requestDigest: string;
  cursor: number;
  receipts: Receipt[];
  status: "running" | "paused" | "completed" | "partial" | "needs-human";
  usage: { modelCalls: number; startedAt: string };
  recoveredCommits: number;
  errors: string[];
}
export function checkpoint(
  v: unknown,
  r: Request,
  rows: Invoice[],
): Checkpoint {
  const c = v as Checkpoint;
  if (
    !c ||
    c.protocol !== protocol ||
    c.requestDigest !== idOf(r) ||
    !["running", "paused", "completed", "partial", "needs-human"].includes(
      c.status,
    ) ||
    !Array.isArray(c.receipts)
  )
    throw new Error("Checkpoint identity or protocol changed");
  if (!Array.isArray(c.errors) || c.errors.some((e) => typeof e !== "string"))
    throw new Error("Invalid checkpoint errors");
  integer(c.cursor, 0, rows.length);
  integer(c.usage.modelCalls, 0, r.maxModelCalls);
  integer(c.recoveredCommits, 0, Math.ceil(rows.length / r.batchSize));
  if (!Number.isFinite(Date.parse(c.usage.startedAt)))
    throw new Error("Invalid start time");
  let cursor = 0,
    parent: string | null = null;
  for (const got of c.receipts) {
    const b = batch(r, rows, cursor);
    if (!b.items.length) throw new Error("Extra checkpoint receipt");
    const expected = receipt(
      r,
      b,
      reviews({ batchId: b.id, reviews: got.reviews }, b),
      parent,
    );
    if (!isDeepStrictEqual(expected, got))
      throw new Error("Checkpoint receipt changed");
    cursor = b.end;
    parent = got.id;
  }
  if (c.status === "completed" && cursor !== rows.length)
    throw new Error("Incomplete checkpoint cannot be completed");
  if (c.receipts.length > c.usage.modelCalls)
    throw new Error("Checkpoint budget is inconsistent");
  if (c.cursor !== cursor) throw new Error("Checkpoint cursor mismatch");
  return c;
}
export interface Report {
  requestId: string;
  status: "completed" | "partial" | "needs-human";
  stopReason: string;
  cursor: number;
  total: number;
  receipts: Receipt[];
  usage: Checkpoint["usage"];
  recoveredCommits: number;
  errors: string[];
  generatedAt: string;
}
