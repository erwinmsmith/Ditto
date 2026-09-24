import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  sources,
  evidence,
  decision,
  acceptance,
  packetId,
  agent,
  hash,
  type Request,
  type Sources,
  type Ticket,
  type Packet,
  type Report,
} from "./domain.ts";
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export type Scenario =
  | "replacement"
  | "resolved"
  | "missing-diagnostic"
  | "out-of-warranty";
export async function createDemo(
  directory: string,
  options: Partial<Omit<Request, "sourceDigest">> = {},
  scenario: Scenario = "replacement",
) {
  if (
    ![
      "replacement",
      "resolved",
      "missing-diagnostic",
      "out-of-warranty",
    ].includes(scenario)
  )
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const s: Sources = {
    orderId: "ORDER-204",
    issue: "设备无法启动，用户已尝试重新连接电源。",
    diagnostic:
      scenario === "resolved"
        ? "resolved"
        : scenario === "missing-diagnostic"
          ? "missing"
          : "hardware-fault",
    warranty: scenario !== "out-of-warranty",
    customerEmail: "customer@example.invalid",
  };
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    goal: "客服受理设备问题后转交技术支持；需要更换时转交售后，由当前负责人处理并交付工单记录。",
    maxModelCalls: 12,
    maxAttempts: 2,
    maxTransfers: 4,
    deadlineSeconds: 600,
    ...options,
    sourceDigest: digest(JSON.stringify(s)),
  });
  await immutable(join(directory, "sources.json"), JSON.stringify(s));
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  const db = new DatabaseSync(join(directory, "tickets.sqlite"));
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS ticket (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS replacements (request_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, status TEXT NOT NULL)",
    );
    const t: Ticket = {
      requestDigest: digest(JSON.stringify(r)),
      owner: "customer-service",
      version: 0,
      status: "active",
      pending: null,
      history: [],
      resolution: null,
    };
    db.prepare("INSERT OR IGNORE INTO ticket VALUES (1, ?)").run(
      JSON.stringify(t),
    );
  } finally {
    db.close();
  }
  return r;
}
export class HandoffAdapters {
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
    if (JSON.stringify(r) !== JSON.stringify(this.request))
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Permission revoked");
    const s = sources(
      JSON.parse(await file(join(this.directory, "sources.json"))),
    );
    if (digest(JSON.stringify(s)) !== r.sourceDigest)
      throw new Error("Source changed");
    return s;
  }
  // The application database owns assignment and acceptance. It is separate from Memory.
  private connect() {
    const db = new DatabaseSync(join(this.directory, "tickets.sqlite"), {
      open: true,
    });
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }
  private read(db: DatabaseSync, s: Sources): Ticket {
    const row = db.prepare("SELECT state FROM ticket WHERE id=1").get();
    if (!row) throw new Error("Missing ticket");
    const t = JSON.parse(String(row.state)) as Ticket;
    if (t.requestDigest !== digest(JSON.stringify(this.request)))
      throw new Error("Ticket scope mismatch");
    let owner: Ticket["owner"] = "customer-service",
      version = 0,
      status: Ticket["status"] = "active",
      parentId: string | null = null,
      resolution: Ticket["resolution"] = null;
    for (const h of t.history) {
      if (status !== "active" || h.version !== version || h.from !== owner)
        throw new Error("Invalid ownership history");
      const d = decision(h.decision, evidence(s, owner));
      if (
        h.kind !== (d.action === "handoff" ? "transfer" : d.action) ||
        h.to !== d.to
      )
        throw new Error("Invalid event");
      if (h.kind === "transfer") {
        const p: Packet = {
          requestDigest: t.requestDigest,
          version,
          from: owner,
          to: d.to!,
          decision: d,
          parentId,
        };
        if (packetId(p) !== h.packetId)
          throw new Error("Handoff checksum mismatch");
        acceptance(h.acceptance, h.packetId, p.to);
        owner = p.to;
        parentId = h.packetId;
      } else {
        if (h.packetId !== null || h.acceptance !== null)
          throw new Error("Unexpected transfer data");
        status = h.kind === "complete" ? "completed" : "needs-human";
        resolution = d.resolution;
      }
      version++;
    }
    if (
      t.owner !== owner ||
      t.version !== version ||
      t.status !== status ||
      t.resolution !== resolution
    )
      throw new Error("Ticket state differs from history");
    if (t.pending) {
      const p = t.pending.packet,
        d = decision(p.decision, evidence(s, owner));
      if (
        status !== "active" ||
        d.action !== "handoff" ||
        p.requestDigest !== t.requestDigest ||
        p.version !== version ||
        p.from !== owner ||
        p.to !== d.to ||
        p.parentId !== parentId ||
        packetId(p) !== t.pending.id
      )
        throw new Error("Invalid pending transfer");
    }
    const replacement = db
      .prepare("SELECT * FROM replacements WHERE request_id=?")
      .get(this.request.id);
    if (
      resolution === "replacement-requested"
        ? !replacement ||
          replacement.order_id !== s.orderId ||
          replacement.status !== "requested"
        : !!replacement
    )
      throw new Error("Replacement state mismatch");
    return t;
  }
  async snapshot() {
    const s = await this.load(),
      db = this.connect();
    try {
      db.exec("BEGIN");
      const ticket = this.read(db, s);
      db.exec("COMMIT");
      return ticket;
    } finally {
      db.close();
    }
  }
  private async transact(
    change: (t: Ticket, s: Sources, db: DatabaseSync) => void,
    signal?: AbortSignal,
  ) {
    const s = await this.load(),
      db = this.connect();
    try {
      signal?.throwIfAborted();
      db.exec("BEGIN IMMEDIATE");
      const t = this.read(db, s);
      change(t, s, db);
      signal?.throwIfAborted();
      db.prepare("UPDATE ticket SET state=? WHERE id=1").run(JSON.stringify(t));
      db.exec("COMMIT");
      return t;
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    } finally {
      db.close();
    }
  }
  async verify(out: Report) {
    const t = await this.snapshot();
    if (
      out.requestId !== this.request.id ||
      JSON.stringify(t) !== JSON.stringify(out.ticket)
    )
      throw new Error("Report ticket mismatch");
    if (
      out.status === "completed"
        ? t.status !== "completed"
        : out.status === "partial"
          ? t.status !== "active"
          : t.status === "completed"
    )
      throw new Error("Invalid report status");
  }
  get tools(): RegisteredTool[] {
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
    const ok = (v: unknown) => ({
      status: "success" as const,
      structuredContent: json(v),
    });
    return [
      tool("handoff_ticket", async () => ok(await this.snapshot())),
      tool("handoff_read", async (a) => {
        const t = await this.snapshot(),
          role = agent(a.agent);
        if (
          t.status !== "active" ||
          t.owner !== role ||
          t.version !== a.version ||
          t.pending
        )
          throw new Error("Agent does not own executable ticket");
        return ok({
          evidence: evidence(await this.load(), role),
          parent: t.history.at(-1) ?? null,
        });
      }),
      tool("handoff_decide", async (a, c) => {
        const role = agent(a.agent),
          s = await this.load();
        let d;
        try {
          d = decision(a.decision, evidence(s, role));
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_DECISION",
              message: "Owner decision failed validation",
            },
          };
        }
        const result = await this.transact((t, source, db) => {
          if (
            t.owner !== role ||
            t.version !== a.version ||
            t.status !== "active"
          )
            throw new Error("Stale owner or version");
          if (t.pending) {
            if (JSON.stringify(t.pending.packet.decision) !== JSON.stringify(d))
              throw new Error("Pending transfer differs");
            return;
          }
          if (d.action === "handoff") {
            if (
              t.history.filter((h) => h.kind === "transfer").length >=
              this.request.maxTransfers
            )
              throw new Error("Transfer budget exceeded");
            const packet: Packet = {
              requestDigest: t.requestDigest,
              version: t.version,
              from: role,
              to: d.to!,
              decision: d,
              parentId: t.history.at(-1)?.packetId ?? null,
            };
            t.pending = { id: packetId(packet), packet };
          } else {
            t.history.push({
              version: t.version,
              kind: d.action,
              from: role,
              to: null,
              packetId: null,
              decision: d,
              acceptance: null,
            });
            if (d.resolution === "replacement-requested")
              db.prepare("INSERT INTO replacements VALUES (?, ?, ?)").run(
                this.request.id,
                source.orderId,
                "requested",
              );
            t.version++;
            t.status = d.action === "complete" ? "completed" : "needs-human";
            t.resolution = d.resolution;
          }
        }, c.signal);
        return ok(result);
      }),
      tool("handoff_accept", async (a, c) => {
        const id = hash(a.packetId),
          to = agent(a.agent);
        let accepted;
        try {
          accepted = acceptance(a.acceptance, id, to);
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_ACCEPTANCE",
              message: "Receiver did not accept this packet",
            },
          };
        }
        return ok(
          await this.transact((t) => {
            const prior = t.history.find((h) => h.packetId === id);
            if (prior) {
              if (JSON.stringify(prior.acceptance) !== JSON.stringify(accepted))
                throw new Error("Acceptance replay differs");
              return;
            }
            const p = t.pending;
            if (
              !p ||
              p.id !== id ||
              p.packet.to !== to ||
              p.packet.version !== a.version ||
              t.version !== a.version ||
              t.owner !== p.packet.from ||
              t.status !== "active"
            )
              throw new Error("Stale or foreign handoff");
            t.history.push({
              version: t.version,
              kind: "transfer",
              from: t.owner,
              to,
              packetId: id,
              decision: p.packet.decision,
              acceptance: accepted,
            });
            t.owner = to;
            t.version++;
            t.pending = null;
          }, c.signal),
        );
      }),
      tool("handoff_publish", async (a) => {
        const out = a.report as unknown as Report;
        await this.verify(out);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        await immutable(
          join(dir, "report.md"),
          `# Agent handoff case\n\nStatus: ${out.status}\nOwner: ${out.ticket.owner}\nStop: ${out.stopReason}\nResolution: ${out.ticket.resolution ?? "unresolved"}\n\n` +
            out.ticket.history
              .map(
                (h) =>
                  `## ${h.from} → ${h.to ?? h.kind}\n\n${h.decision.summary}\n\n${h.acceptance?.summary ?? ""}\n\n` +
                  h.decision.citations
                    .map((x) => `- ${x.id}: ${x.quote}`)
                    .join("\n"),
              )
              .join("\n\n") +
            "\n",
        );
        return ok({ published: true });
      }),
    ];
  }
}
