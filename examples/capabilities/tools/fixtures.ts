import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID, randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { smtpSdk } from "../../_shared/tools/operations/sdk.ts";
import { request, digest, type Request, type Mode } from "../../_shared/tools/operations/domain.ts";
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error("Request too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
export async function serveFixture(directory: string, r: Request, ports = { http: 0, smtp: 0 }) {
  const db = new DatabaseSync(join(directory, "business.sqlite")); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  let failApi = false, failMail = false, dropAfterWrite = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost"), send = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    try {
      if (failApi) { send({ error: "unavailable" }, 503); return; }
      if (url.pathname === "/rate") { if (url.searchParams.get("currency") !== "USD") { send({}, 400); return; } send({ currency: "USD", rate: 7.2 }); return; }
      if (url.pathname === "/shipping") { const weight = Number(url.searchParams.get("weight")); if (url.searchParams.get("country") !== "SG" || url.searchParams.get("service") !== "express" || weight !== r.weight) { send({}, 400); return; } send({ cents: weight * 125 + 400 }); return; }
      if (url.pathname === "/order") { const order = db.prepare("SELECT id AS orderId,quantity*unit_cents AS totalCents,status FROM orders WHERE id=? AND tenant=?").get(url.searchParams.get("id"), r.tenant); send(order ?? {}, order ? 200 : 404); return; }
      if (url.pathname === "/export") { const order = db.prepare("SELECT id,quantity*unit_cents AS total FROM orders WHERE id=? AND tenant=?").get(url.searchParams.get("id"), r.tenant); if (!order) { send({}, 404); return; } res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="orders.csv"' }); res.end(`orderId,totalCents\n${order.id},${order.total}\n`); return; }
      if (url.pathname === "/browser") { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><meta charset="utf-8"><title>Order export</title><h1>Order export</h1><label>Order ID<input id="order"></label><button id="find">Find</button><pre id="result"></pre><a id="download" hidden>Download CSV</a><script>document.getElementById('find').onclick=async()=>{const id=document.getElementById('order').value;const response=await fetch('/order?id='+encodeURIComponent(id));if(!response.ok)return;document.getElementById('result').textContent=JSON.stringify(await response.json());const link=document.getElementById('download');link.href='/export?id='+encodeURIComponent(id);link.hidden=false;};</script>`); return; }
      if (url.pathname.startsWith("/mailbox/")) { const mail = db.prepare("SELECT id,recipient,subject,body FROM mail WHERE id=?").get(decodeURIComponent(url.pathname.slice(9))); send(mail ?? {}, mail ? 200 : 404); return; }
      if (url.pathname.startsWith("/operations/")) { const row = db.prepare("SELECT result FROM operations WHERE id=?").get(url.pathname.slice(12)); send(row ? JSON.parse(String(row.result)) : {}, row ? 200 : 404); return; }
      if (url.pathname === "/crm" && req.method === "PATCH") {
        const value = await body(req), id = req.headers["idempotency-key"]; if (id !== r.id || value.ticketId !== r.ticketId || value.status !== "resolved") { send({}, 403); return; }
        const saved = db.prepare("SELECT fingerprint,result FROM operations WHERE id=?").get(String(id));
        if (saved) { if (saved.fingerprint !== digest(value)) { send({}, 409); return; } send(JSON.parse(String(saved.result))); return; }
        db.exec("BEGIN IMMEDIATE");
        try { const result = { ticketId: r.ticketId, status: "resolved", note: value.note, version: 2 }; const changed = db.prepare("UPDATE tickets SET status=?,note=?,version=version+1 WHERE id=? AND version=1").run(value.status, value.note, value.ticketId); if (Number(changed.changes) !== 1) throw new Error("Ticket version conflict"); db.prepare("INSERT INTO operations VALUES(?,?,?)").run(String(id), digest(value), JSON.stringify(result)); db.exec("COMMIT"); if (dropAfterWrite) { dropAfterWrite = false; req.socket.destroy(); return; } send(result); }
        catch (error) { db.exec("ROLLBACK"); throw error; } return;
      }
      send({}, 404);
    } catch { if (!res.headersSent) send({ error: "operation failed" }, 500); else res.destroy(); }
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(ports.http, "127.0.0.1", done); });
  const { SMTPServer } = smtpSdk();
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ["AUTH", "STARTTLS"], logger: false,
    onRcptTo(address: { address: string }, _: unknown, callback: (error?: Error) => void) { callback(address.address === r.recipient ? undefined : new Error("Recipient denied")); },
    async onData(stream: AsyncIterable<Buffer>, session: { envelope: { rcptTo: { address: string }[] } }, callback: (error?: Error) => void) {
      try { const parts: Buffer[] = []; let size = 0; for await (const chunk of stream) { size += chunk.length; if (size > 65536) throw new Error("Message too large"); parts.push(chunk); } if (failMail) throw new Error("Mailbox unavailable");
        const raw = Buffer.concat(parts).toString("utf8"), id = /^Message-ID:\s*<([^>]+)>/im.exec(raw)?.[1], subject = /^Subject:\s*([^\r\n]+)/im.exec(raw)?.[1], text = raw.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim(); if (!id || !subject) throw new Error("Missing email headers");
        const prior = db.prepare("SELECT body FROM mail WHERE id=?").get(id); if (prior && prior.body !== text) throw new Error("Message ID conflict");
        db.prepare("INSERT OR IGNORE INTO mail VALUES(?,?,?,?,?)").run(id, session.envelope.rcptTo[0]!.address, subject, text, raw); callback();
      } catch { callback(new Error("Mailbox rejected message")); }
    },
  });
  try { await new Promise<void>(done => smtp.listen(ports.smtp, "127.0.0.1", done)); } catch (error) { server.close(); db.close(); throw error; }
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing HTTP port");
  return { origin: `http://127.0.0.1:${address.port}`, smtpPort: smtp.server.address().port, db,
    failApi(value: boolean) { failApi = value; }, failMail(value: boolean) { failMail = value; }, dropAfterWrite() { dropAfterWrite = true; },
    async close() { await Promise.all([new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())), new Promise<void>((done, reject) => smtp.close(error => error ? reject(error) : done()))]); db.close(); },
  };
}
export async function createFixture(directory: string, mode: Mode) {
  const r: Request = { id: randomUUID(), tenant: "team-a", mode, authorized: true, orderId: `ORD-${randomInt(10000, 99999)}`, ticketId: `TKT-${randomInt(10000, 99999)}`, quantity: randomInt(3, 10), unitCents: randomInt(100, 900), weight: randomInt(2, 12), country: "SG", currency: "USD", recipient: "operations@example.test", origin: "http://127.0.0.1", smtpPort: 1 };
  const db = new DatabaseSync(join(directory, "business.sqlite"));
  try { db.exec("CREATE TABLE orders(id TEXT PRIMARY KEY,tenant TEXT,quantity INTEGER,unit_cents INTEGER,status TEXT); CREATE TABLE inventory(sku TEXT PRIMARY KEY,tenant TEXT,stock INTEGER); CREATE TABLE tickets(id TEXT PRIMARY KEY,status TEXT,note TEXT,version INTEGER); CREATE TABLE operations(id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT); CREATE TABLE mail(id TEXT PRIMARY KEY,recipient TEXT,subject TEXT,body TEXT,raw TEXT)"); db.prepare("INSERT INTO orders VALUES(?,?,?,?,?)").run(r.orderId,r.tenant,r.quantity,r.unitCents,"paid"); db.prepare("INSERT INTO orders VALUES(?,?,?,?,?)").run("PRIVATE-OTHER","team-b",99,999,"private"); db.prepare("INSERT INTO inventory VALUES(?,?,?)").run("SKU-EXAMPLE",r.tenant,42); db.prepare("INSERT INTO tickets VALUES(?,?,?,?)").run(r.ticketId,"open","",1); } finally { db.close(); }
  await writeFile(join(directory, "draft.txt"), "Order review draft.\n");
  const services = await serveFixture(directory, r); r.origin = services.origin; r.smtpPort = services.smtpPort;
  await writeFile(join(directory, "request.json"), JSON.stringify(r)); return { request: r, services };
}
export async function resumeFixture(directory: string) { const r = request(JSON.parse(await readFile(join(directory, "request.json"), "utf8"))); return { request: r, services: await serveFixture(directory, r, { http: Number(new URL(r.origin).port), smtp: r.smtpPort }) }; }
