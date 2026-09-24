/** Local reference integration: an HTTP inventory service with its own durable SQLite ledger. */
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

export interface Order { sku: string; quantity: number; address: string }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
export function order(value: unknown): Order {
  const data = object(value);
  if (typeof data.quantity !== "number" || !Number.isSafeInteger(data.quantity) || data.quantity < 1 || data.quantity > 100
    || typeof data.address !== "string" || !data.address.trim() || data.address.length > 200) throw new Error("Invalid order");
  return { sku: identifier(data.sku), quantity: data.quantity, address: data.address };
}
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type OperationKind = "reserve" | "ship" | "release";
export interface Operation { state: "absent" | "pending" | "committed" | "rejected"; fingerprint?: string; result?: Record<string, unknown>; code?: string }
export const operationFingerprint = (kind: OperationKind, value: Order, reservationKey: string) => hash({ kind, order: order(value), reservationKey });
export interface ServiceFaults {
  primaryUnavailable?: boolean; catalogDelayMs?: number; rejectShipping?: boolean;
  dropReservationResponse?: boolean; rejectRelease?: boolean; lookupUnavailable?: boolean; lookupUnavailableAfterWrite?: boolean; reservationDelayMs?: number;
}
/** Fault switches belong to this reference service's experiment setup, never Core or the client protocol. */
export async function startFulfillmentService(path: string, stock: { sku: string; quantity: number }[], faults: ServiceFaults = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS inventory(sku TEXT PRIMARY KEY,quantity INTEGER NOT NULL CHECK(quantity>=0));
    CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,code TEXT);
    CREATE TABLE IF NOT EXISTS reservations(key TEXT PRIMARY KEY,sku TEXT NOT NULL,quantity INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shipments(key TEXT PRIMARY KEY,reservationKey TEXT UNIQUE NOT NULL,address TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(seq INTEGER PRIMARY KEY,method TEXT,path TEXT);
  `);
  for (const row of stock) db.prepare("INSERT OR IGNORE INTO inventory VALUES(?,?)").run(identifier(row.sku), row.quantity);
  function lookup(key: string): Operation {
    const row = db.prepare("SELECT * FROM operations WHERE key=?").get(key);
    return row ? { state: row.state as Operation["state"], fingerprint: String(row.fingerprint), ...(row.result ? { result: JSON.parse(String(row.result)) } : {}), ...(row.code ? { code: String(row.code) } : {}) } : { state: "absent" };
  }
  function respond(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  }
  let active = 0;
  const server = createServer((request, response) => {
    active++;
    void (async () => {
      const url = new URL(request.url!, "http://localhost");
      db.prepare("INSERT INTO requests(method,path) VALUES(?,?)").run(request.method!, url.pathname);
      if (request.method === "GET" && url.pathname.startsWith("/catalog/")) {
        const source = url.pathname.slice("/catalog/".length);
        if (!["primary", "backup"].includes(source)) return respond(response, 404, { code: "NOT_FOUND" });
        if (source === "primary" && faults.primaryUnavailable) return respond(response, 503, { code: "UNAVAILABLE" });
        if (source === "primary" && faults.catalogDelayMs) await setTimeout(faults.catalogDelayMs);
        const sku = identifier(url.searchParams.get("sku")), row = db.prepare("SELECT quantity FROM inventory WHERE sku=?").get(sku);
        return respond(response, row ? 200 : 404, row ? { sku, available: row.quantity, source } : { code: "SKU_NOT_FOUND" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/operations/")) {
        if (faults.lookupUnavailable || (faults.lookupUnavailableAfterWrite && Number(db.prepare("SELECT count(*) AS n FROM operations").get()!.n) > 0)) return respond(response, 503, { code: "LOOKUP_UNAVAILABLE" });
        return respond(response, 200, lookup(identifier(decodeURIComponent(url.pathname.slice("/operations/".length)))));
      }
      if (request.method !== "POST" || !["/reserve", "/ship", "/release"].includes(url.pathname)) return respond(response, 404, { code: "NOT_FOUND" });
      let body = "";
      for await (const chunk of request) { body += String(chunk); if (body.length > 8192) return respond(response, 413, { code: "BODY_LIMIT" }); }
      const args = object(JSON.parse(body)), key = identifier(args.key), value = order(args.order), reservationKey = identifier(args.reservationKey);
      const kind = url.pathname.slice(1) as OperationKind, fingerprint = operationFingerprint(kind, value, reservationKey);
      const previous = lookup(key);
      if (previous.state !== "absent") {
        if (previous.fingerprint !== fingerprint) return respond(response, 409, { code: "IDEMPOTENCY_CONFLICT" });
        return respond(response, previous.state === "pending" ? 202 : previous.state === "committed" ? 200 : 422, previous);
      }
      // Claim the key before asynchronous work: a concurrent retry observes pending, never creates a second operation.
      db.prepare("INSERT INTO operations(key,kind,fingerprint,state) VALUES(?,?,?,?)").run(key, kind, fingerprint, "pending");
      if (kind === "reserve" && faults.reservationDelayMs) await setTimeout(faults.reservationDelayMs);
      db.exec("BEGIN IMMEDIATE");
      try {
        let code: string | null = null, result: Record<string, unknown> = {};
        if (kind === "reserve") {
          const changed = db.prepare("UPDATE inventory SET quantity=quantity-? WHERE sku=? AND quantity>=?").run(value.quantity, value.sku, value.quantity);
          if (!changed.changes) code = "INSUFFICIENT_STOCK";
          else { db.prepare("INSERT INTO reservations VALUES(?,?,?,?)").run(key, value.sku, value.quantity, "active"); result = { reservationKey: key, ...value }; }
        } else {
          const reservation = db.prepare("SELECT * FROM reservations WHERE key=?").get(reservationKey);
          if (!reservation || reservation.sku !== value.sku || reservation.quantity !== value.quantity) code = "RESERVATION_MISMATCH";
          else if (kind === "ship") {
            if (faults.rejectShipping) code = "ADDRESS_REJECTED";
            else if (reservation.status !== "active") code = "RESERVATION_INACTIVE";
            else if (db.prepare("SELECT key FROM shipments WHERE reservationKey=?").get(reservationKey)) code = "ALREADY_SHIPPED";
            else { db.prepare("INSERT INTO shipments VALUES(?,?,?)").run(key, reservationKey, value.address); result = { shipmentKey: key, reservationKey, ...value }; }
          } else {
            if (faults.rejectRelease) code = "RELEASE_REJECTED";
            else if (db.prepare("SELECT key FROM shipments WHERE reservationKey=?").get(reservationKey)) code = "ALREADY_SHIPPED";
            else {
              if (reservation.status === "active") {
                db.prepare("UPDATE inventory SET quantity=quantity+? WHERE sku=?").run(value.quantity, value.sku);
                db.prepare("UPDATE reservations SET status='released' WHERE key=?").run(reservationKey);
              }
              result = { reservationKey, status: "released", ...value };
            }
          }
        }
        db.prepare("UPDATE operations SET state=?,result=?,code=? WHERE key=?").run(code ? "rejected" : "committed", code ? null : JSON.stringify(result), code, key);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (kind === "reserve" && faults.dropReservationResponse) { response.destroy(); return; }
      const outcome = lookup(key);
      respond(response, outcome.state === "committed" ? 200 : 422, outcome);
    })().catch(() => { if (!response.headersSent) respond(response, 500, { code: "SERVICE_ERROR" }); else response.destroy(); }).finally(() => { active--; });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service did not bind");
  return { url: `http://127.0.0.1:${address.port}`, db, lookup, faults,
    async close() {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      while (active) await setTimeout(5);
      db.close();
    },
  };
}
