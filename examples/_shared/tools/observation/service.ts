import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { request, type Request, type Mode, type Scenario } from "./domain.ts";
export async function serve(directory: string, r: Request, port = 0) {
  const db = new DatabaseSync(join(directory, "remote.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  let dropRetry = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (
        url.searchParams.get("id") !== r.orderId ||
        req.headers["x-tenant"] !== r.tenant
      ) {
        send({ error: "not found" }, 404);
        return;
      }
      const row = db
        .prepare("SELECT * FROM jobs WHERE id=? AND tenant=?")
        .get(r.orderId, r.tenant)!;
      const value = {
        orderId: row.id,
        quantity: row.quantity,
        unitCents: row.unit_cents,
        status: "completed",
      };
      db.prepare("INSERT INTO requests(path) VALUES(?)").run(url.pathname);
      if (url.pathname === "/retry" && req.method === "POST") {
        if (req.headers["idempotency-key"] !== r.id + ":retry") {
          send({}, 403);
          return;
        }
        db.prepare(
          "UPDATE jobs SET retries=1,status='completed' WHERE id=? AND retries=0",
        ).run(r.orderId);
        if (dropRetry) {
          dropRetry = false;
          req.socket.destroy();
          return;
        }
        if (r.scenario === "persistent-transient") {
          send({ error: "temporarily unavailable" }, 503);
          return;
        }
        send(value);
        return;
      }
      if (url.pathname === "/status") {
        if (row.status !== "completed") {
          send({ error: "status unavailable" }, 503);
          return;
        }
        send(value);
        return;
      }
      if (url.pathname !== "/result") {
        send({}, 404);
        return;
      }
      if (Number(row.retries) === 0 && Number(row.fault_used) === 0) {
        if (
          r.scenario === "transient" ||
          r.scenario === "persistent-transient"
        ) {
          send({ error: "temporarily unavailable" }, 503);
          return;
        }
        if (r.scenario === "denied") {
          send({ error: "permission denied" }, 403);
          return;
        }
        if (r.scenario === "not-found") {
          send({ error: "not found" }, 404);
          return;
        }
        if (r.scenario === "cancelled") {
          send({ error: "cancelled by operator" }, 409);
          return;
        }
        if (r.scenario === "timeout" || r.scenario === "disconnect") {
          db.prepare(
            "UPDATE jobs SET status='completed',fault_used=1 WHERE id=?",
          ).run(r.orderId);
          if (r.scenario === "disconnect") req.socket.destroy();
          else {
            const timer = setTimeout(() => send(value), 600);
            res.once("close", () => clearTimeout(timer));
          }
          return;
        }
        if (r.scenario === "malformed") {
          res.end("invalid csv with missing fields");
          return;
        }
        if (r.scenario === "business-failure") {
          send({ ...value, status: "failed", error: "stock unavailable" });
          return;
        }
      }
      if (r.mode === "normalize") {
        res.writeHead(200, { "content-type": "text/csv" });
        res.end(
          `orderId,quantity,unitCents,status\n${row.id},${row.quantity},${row.unit_cents},completed\n`,
        );
      } else send(value);
    } catch {
      send({ error: "service error" }, 500);
    }
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", done);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No service port");
  return {
    db,
    origin: `http://127.0.0.1:${address.port}`,
    dropRetry() {
      dropRetry = true;
    },
    async close() {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      db.close();
    },
  };
}
export async function createFixture(
  directory: string,
  mode: Mode,
  scenario: Scenario = mode === "errors"
    ? "transient"
    : mode === "interpret"
      ? "timeout"
      : "success",
) {
  const r: Request = {
    id: randomUUID(),
    tenant: "team-a",
    mode,
    scenario,
    orderId: `ORD-${randomInt(10000, 99999)}`,
    origin: "http://127.0.0.1",
  };
  const db = new DatabaseSync(join(directory, "remote.sqlite"));
  try {
    db.exec(
      "CREATE TABLE jobs(id TEXT PRIMARY KEY,tenant TEXT,quantity INTEGER,unit_cents INTEGER,status TEXT,retries INTEGER,fault_used INTEGER); CREATE TABLE requests(path TEXT)",
    );
    db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,0,0)").run(
      r.orderId,
      r.tenant,
      randomInt(2, 9),
      randomInt(100, 500),
      scenario === "success" ? "completed" : "pending",
    );
  } finally {
    db.close();
  }
  const service = await serve(directory, r);
  r.origin = service.origin;
  await writeFile(join(directory, "request.json"), JSON.stringify(r));
  return { request: r, service };
}
export async function resumeFixture(directory: string) {
  const r = request(
    JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
  );
  return {
    request: r,
    service: await serve(directory, r, Number(new URL(r.origin).port)),
  };
}
