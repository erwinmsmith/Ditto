import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  request,
  expected,
  payload,
  type Request,
  type Snapshot,
  type Receipt,
} from "./domain.ts";
export type Scenario =
  | "exception"
  | "healthy"
  | "stale"
  | "crm-disconnect"
  | "notify-disconnect"
  | "notify-fails"
  | "payment-fails"
  | "change-after-crm"
  | "racing-read";
export async function serve(
  directory: string,
  r: Request,
  scenario: Scenario,
  port = 0,
) {
  const db = new DatabaseSync(join(directory, "business.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  const state = () =>
    db.prepare("SELECT * FROM orders WHERE id=?").get(r.orderId)!;
  const business = (): Snapshot => {
    const o = state(),
      c = db.prepare("SELECT * FROM customers WHERE id=?").get(r.customerId)!;
    return {
      customer: {
        customerId: String(c.id),
        recipient: String(c.recipient),
        active: c.active === 1,
      },
      order: {
        orderId: String(o.id),
        customerId: String(o.customer_id),
        revision: Number(o.revision),
      },
      payment: {
        orderId: r.orderId,
        revision: Number(o.revision),
        state: String(o.payment) as "paid" | "pending",
      },
      shipment: {
        orderId: r.orderId,
        revision: Number(o.revision),
        state: String(o.shipment) as "shipped" | "delayed",
      },
    };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const started = Date.now(),
      log = db
        .prepare("INSERT INTO requests(path,started,ended) VALUES(?,?,NULL)")
        .run(url.pathname, started).lastInsertRowid;
    const finish = () =>
      db
        .prepare("UPDATE requests SET ended=? WHERE rowid=?")
        .run(Date.now(), log);
    const send = (v: unknown, status = 200) => {
      finish();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    try {
      if (
        req.headers["x-task-id"] !== r.id ||
        url.searchParams.get("customerId") !== r.customerId ||
        url.searchParams.get("orderId") !== r.orderId
      ) {
        send({ code: "SCOPE_DENIED" }, 403);
        return;
      }
      if (req.method === "GET") {
        if (url.pathname === "/operation") {
          const key = url.searchParams.get("key"),
            row = db
              .prepare("SELECT receipt FROM operations WHERE key=?")
              .get(key ?? "");
          if (![`${r.id}:crm`, `${r.id}:notify`].includes(key ?? "")) {
            send({ code: "SCOPE_DENIED" }, 403);
            return;
          }
          send(
            row ? JSON.parse(String(row.receipt)) : { code: "NOT_FOUND" },
            row ? 200 : 404,
          );
          return;
        }
        if (url.pathname === "/verify") {
          send({
            snapshot: business(),
            crm:
              db
                .prepare("SELECT * FROM crm WHERE customer_id=?")
                .get(r.customerId) ?? null,
            notifications: db
              .prepare("SELECT * FROM inbox WHERE task_id=?")
              .all(r.id),
          });
          return;
        }
        const b = business();
        if (url.pathname === "/customer") {
          send(b.customer);
          return;
        }
        if (url.pathname === "/orders") {
          send(b.order);
          return;
        }
        if (url.pathname === "/payment" || url.pathname === "/shipment") {
          if (
            url.pathname === "/payment" &&
            scenario === "racing-read" &&
            b.order.revision === 1
          )
            db.exec("UPDATE orders SET revision=2");
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (url.pathname === "/payment" && scenario === "payment-fails") {
            send({ code: "PAYMENT_UNAVAILABLE" }, 503);
            return;
          }
          send(url.pathname === "/payment" ? b.payment : b.shipment);
          return;
        }
      }
      if (
        req.method === "POST" &&
        (url.pathname === "/crm" || url.pathname === "/notify")
      ) {
        let raw = "";
        for await (const chunk of req) {
          raw += String(chunk);
          if (raw.length > 10000) throw new Error("Request too large");
        }
        const input = JSON.parse(raw),
          kind = url.pathname === "/crm" ? "crm" : "notify",
          key = `${r.id}:${kind}`;
        if (
          req.headers["idempotency-key"] !== key ||
          !r.allowCrmWrite ||
          (kind === "notify" && !r.allowNotify)
        ) {
          send({ code: "PERMISSION_DENIED" }, 403);
          return;
        }
        const old = db
          .prepare("SELECT receipt FROM operations WHERE key=?")
          .get(key);
        if (old) {
          const receipt = JSON.parse(String(old.receipt));
          if (JSON.stringify(receipt.payload) !== JSON.stringify(input)) {
            send({ code: "IDEMPOTENCY_CONFLICT" }, 409);
            return;
          }
          send(receipt);
          return;
        }
        if (
          kind === "crm" &&
          scenario === "stale" &&
          Number(state().revision) === 1
        )
          db.exec("UPDATE orders SET revision=2");
        const b = business(),
          d = { ...expected(b, r), explanation: "" },
          authorized = payload(d, r);
        if (
          !d.updateCrm ||
          JSON.stringify(input) !== JSON.stringify(authorized)
        ) {
          send({ code: "STALE_STATE" }, 409);
          return;
        }
        if (kind === "notify") {
          const prior = db
            .prepare("SELECT receipt FROM operations WHERE key=?")
            .get(`${r.id}:crm`);
          if (
            !prior ||
            JSON.stringify(JSON.parse(String(prior.receipt)).payload) !==
              JSON.stringify(input)
          ) {
            send({ code: "CRM_NOT_COMMITTED" }, 409);
            return;
          }
          if (scenario === "notify-fails") {
            send({ code: "NOTIFICATION_UNAVAILABLE" }, 503);
            return;
          }
        }
        const receipt: Receipt = { key, kind, payload: authorized };
        db.exec("BEGIN IMMEDIATE");
        try {
          if (kind === "crm")
            db.prepare(
              "INSERT INTO crm VALUES(?,?,?,?,1) ON CONFLICT(customer_id) DO UPDATE SET status=excluded.status,revision=excluded.revision,message=excluded.message,updates=updates+1",
            ).run(r.customerId, input.status, input.revision, input.message);
          else
            db.prepare("INSERT INTO inbox VALUES(?,?,?,?)").run(
              key,
              r.id,
              r.recipient,
              input.message,
            );
          db.prepare("INSERT INTO operations VALUES(?,?)").run(
            key,
            JSON.stringify(receipt),
          );
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        if (kind === "crm" && scenario === "change-after-crm")
          db.exec("UPDATE orders SET revision=revision+1");
        if (
          (kind === "crm" && scenario === "crm-disconnect") ||
          (kind === "notify" && scenario === "notify-disconnect")
        ) {
          finish();
          res.destroy();
          return;
        }
        send(receipt);
        return;
      }
      send({ code: "NOT_FOUND" }, 404);
    } catch {
      if (!res.destroyed) send({ code: "SERVICE_ERROR" }, 500);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No service address");
  return {
    db,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      db.close();
    },
  };
}
export async function createDemo(
  directory: string,
  scenario: Scenario = "exception",
  overrides: Partial<Request> = {},
) {
  if (
    ![
      "exception",
      "healthy",
      "stale",
      "crm-disconnect",
      "notify-disconnect",
      "notify-fails",
      "payment-fails",
      "change-after-crm",
      "racing-read",
    ].includes(scenario)
  )
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    customerId: "CUST-204",
    orderId: "ORDER-204",
    recipient: "ops@example.test",
    origin: "http://127.0.0.1",
    goal: "查询客户和订单，核对付款与物流状态，根据授权更新 CRM，并发送状态通知。",
    mode: "conditional",
    allowCrmWrite: true,
    allowNotify: true,
    maxRounds: 3,
    maxModelCalls: 3,
    maxEffects: 6,
    maxEffectAttempts: 2,
    deadlineSeconds: 600,
    ...overrides,
  });
  const db = new DatabaseSync(join(directory, "business.sqlite"));
  try {
    db.exec(
      "CREATE TABLE customers(id TEXT PRIMARY KEY,recipient TEXT,active INTEGER);CREATE TABLE orders(id TEXT PRIMARY KEY,customer_id TEXT,revision INTEGER,payment TEXT,shipment TEXT);CREATE TABLE crm(customer_id TEXT PRIMARY KEY,status TEXT,revision INTEGER,message TEXT,updates INTEGER);CREATE TABLE operations(key TEXT PRIMARY KEY,receipt TEXT);CREATE TABLE inbox(key TEXT PRIMARY KEY,task_id TEXT,recipient TEXT,message TEXT);CREATE TABLE requests(path TEXT,started INTEGER,ended INTEGER)",
    );
    db.prepare("INSERT INTO customers VALUES(?,?,1)").run(
      r.customerId,
      r.recipient,
    );
    db.prepare("INSERT INTO orders VALUES(?,?,1,?,?)").run(
      r.orderId,
      r.customerId,
      scenario === "healthy" ? "paid" : "pending",
      scenario === "healthy" ? "shipped" : "delayed",
    );
  } finally {
    db.close();
  }
  const service = await serve(directory, r, scenario),
    normalized = request({ ...r, origin: service.origin });
  await writeFile(
    join(directory, "demo.json"),
    JSON.stringify({ scenario, request: normalized }),
  );
  return { request: normalized, service };
}
export async function resumeDemo(directory: string) {
  const d = JSON.parse(await readFile(join(directory, "demo.json"), "utf8")),
    r = request(d.request);
  return {
    request: r,
    service: await serve(
      directory,
      r,
      d.scenario,
      Number(new URL(r.origin).port),
    ),
  };
}
