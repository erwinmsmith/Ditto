import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  operations,
  plan,
  type Request,
  type Snapshot,
  type Operation,
  type Report,
  type Step,
} from "./domain.ts";
export type Scenario =
  | "stable"
  | "price-change"
  | "unavailable"
  | "no-stock"
  | "lost-response";
async function regular(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 500000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
export async function createDemo(
  directory: string,
  scenario: Scenario = "price-change",
  overrides: Partial<Request> = {},
) {
  if (
    ![
      "stable",
      "price-change",
      "unavailable",
      "no-stock",
      "lost-response",
    ].includes(scenario)
  )
    throw new Error("Invalid scenario");
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    orderId: "ORDER-204",
    goal: "为订单完成备货、打包和订运，优先选择 standard 承运商，运费不得超过预算；核对运输回执。",
    quantity: 2,
    maxShippingCents: 500,
    maxPlans: 3,
    maxActions: 12,
    deadlineSeconds: 600,
    ...overrides,
  });
  await mkdir(directory, { recursive: true });
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({
      fingerprint: digest(JSON.stringify(r)),
      enabled: true,
      principals: [r.principal],
    }),
  );
  const db = new DatabaseSync(join(directory, "business.sqlite"));
  try {
    db.exec(
      "CREATE TABLE state (state TEXT, stock INTEGER, standard INTEGER, economy INTEGER, carrier TEXT, cost INTEGER); CREATE TABLE operations (id TEXT PRIMARY KEY, result TEXT NOT NULL); CREATE TABLE config (scenario TEXT, fingerprint TEXT)",
    );
    db.prepare("INSERT INTO state VALUES ('new',?,300,400,NULL,NULL)").run(
      scenario === "no-stock" ? 0 : 10,
    );
    db.prepare("INSERT INTO config VALUES (?,?)").run(
      scenario,
      digest(JSON.stringify(r)),
    );
  } finally {
    db.close();
  }
  return r;
}
export class PlanAdapters {
  readonly directory: string;
  readonly request: Request;
  readonly db: DatabaseSync;
  constructor(directory: string, r: Request) {
    this.directory = directory;
    this.request = request(r);
    this.db = new DatabaseSync(join(directory, "business.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  }
  close() {
    this.db.close();
  }
  snapshot(): Snapshot {
    return this.db.prepare("SELECT * FROM state").get() as unknown as Snapshot;
  }
  async authorize() {
    const r = request(
        JSON.parse(await regular(join(this.directory, "request.json"))),
      ),
      p = object(
        JSON.parse(await regular(join(this.directory, "policy.json"))),
      );
    if (
      JSON.stringify(r) !== JSON.stringify(this.request) ||
      p.fingerprint !== digest(JSON.stringify(r)) ||
      this.db.prepare("SELECT fingerprint FROM config").get()!.fingerprint !==
        p.fingerprint
    )
      throw new Error("Task request changed");
    if (
      p.enabled !== true ||
      !Array.isArray(p.principals) ||
      !p.principals.includes(r.principal)
    )
      throw new Error("Task permission revoked");
  }
  async evidence(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence ID");
    const e = object(
      JSON.parse(await regular(join(this.directory, "evidence", id + ".json"))),
    );
    if (
      digest(JSON.stringify(e)) !== id ||
      e.fingerprint !== digest(JSON.stringify(this.request))
    )
      throw new Error("Evidence checksum mismatch");
    return e;
  }
  async record(tool: string, data: unknown) {
    const e = { fingerprint: digest(JSON.stringify(this.request)), tool, data },
      evidenceId = digest(JSON.stringify(e));
    await mkdir(join(this.directory, "evidence"), { recursive: true });
    await immutable(
      join(this.directory, "evidence", evidenceId + ".json"),
      JSON.stringify(e),
    );
    return { evidenceId, ...object(data) };
  }
  // Stable semantic operation keys survive plan versions and model-generated step IDs.
  operate(tool: Operation) {
    const r = this.request,
      key = tool.startsWith("ship_") ? "shipment" : tool;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT result FROM operations WHERE id=?")
        .get(key);
      if (existing) {
        this.db.exec("COMMIT");
        return {
          data: object(JSON.parse(String(existing.result))),
          replayed: true,
        };
      }
      const s = this.snapshot(),
        scenario = String(
          this.db.prepare("SELECT scenario FROM config").get()!.scenario,
        );
      let data: Record<string, unknown>;
      if (tool === "reserve_stock") {
        if (s.state !== "new" || s.stock < r.quantity)
          throw new Error("ENVIRONMENT_CHANGED");
        this.db
          .prepare("UPDATE state SET stock=stock-?, state='reserved'")
          .run(r.quantity);
        data = { state: "reserved", quantity: r.quantity };
      } else if (tool === "pack_order") {
        if (s.state !== "reserved") throw new Error("ENVIRONMENT_CHANGED");
        this.db.exec("UPDATE state SET state='packed'");
        // A supplier tariff change happens after the initial plan, in the real business database.
        if (scenario === "price-change" || scenario === "unavailable")
          this.db.exec("UPDATE state SET standard=900");
        if (scenario === "unavailable")
          this.db.exec("UPDATE state SET economy=900");
        data = { state: "packed", quantity: r.quantity };
      } else if (tool.startsWith("ship_")) {
        const carrier = tool === "ship_standard" ? "standard" : "economy",
          cost = s[carrier];
        if (s.state !== "packed" || cost > r.maxShippingCents)
          throw new Error("ENVIRONMENT_CHANGED");
        data = {
          state: "shipped",
          orderId: r.orderId,
          quantity: r.quantity,
          carrier,
          cost,
          tracking: `DEMO-${r.id}`,
        };
        this.db
          .prepare("UPDATE state SET state='shipped',carrier=?,cost=?")
          .run(carrier, cost);
      } else {
        const shipment = this.db
          .prepare("SELECT result FROM operations WHERE id='shipment'")
          .get();
        if (s.state !== "shipped" || !shipment)
          throw new Error("ENVIRONMENT_CHANGED");
        data = {
          ...object(JSON.parse(String(shipment.result))),
          state: "receipt",
        };
      }
      this.db
        .prepare("INSERT INTO operations VALUES (?,?)")
        .run(key, JSON.stringify(data));
      this.db.exec("COMMIT");
      return { data, replayed: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async validateReport(input: unknown): Promise<Report> {
    const out = input as Report,
      r = this.request;
    if (
      out.requestId !== r.id ||
      !["completed", "partial", "needs-human"].includes(out.status) ||
      !Array.isArray(out.plans) ||
      !Array.isArray(out.completed)
    )
      throw new Error("Invalid report");
    for (const [i, p] of out.plans.entries()) {
      if (p.version !== i + 1) throw new Error("Invalid plan version");
      plan(p.plan, r, p.snapshot);
    }
    for (const c of out.completed) {
      const step = out.plans[c.version - 1]?.plan.steps.find(
        (s) => s.id === c.step.id,
      );
      if (JSON.stringify(step) !== JSON.stringify(c.step))
        throw new Error("Unplanned execution");
      const e = await this.evidence(c.evidenceId);
      if (e.tool !== c.step.tool || object(e.data).state !== c.step.expected)
        throw new Error("Step verification failed");
    }
    if (out.status === "completed") {
      const receipt = out.completed.find((c) => c.step.tool === "read_receipt");
      if (!receipt) throw new Error("Missing verified receipt");
      const e = object((await this.evidence(receipt.evidenceId)).data),
        { state: _state, ...expected } = e;
      if (
        JSON.stringify(expected) !== JSON.stringify(out.receipt) ||
        Number(e.cost) > r.maxShippingCents ||
        e.orderId !== r.orderId ||
        e.quantity !== r.quantity
      )
        throw new Error("Receipt mismatch");
    } else if (out.receipt !== null) throw new Error("Unverified receipt");
    return out;
  }
  get tools(): RegisteredTool[] {
    const tool = (
      name: string,
      effects: RegisteredTool["effects"],
      run: RegisteredTool["execute"],
    ): RegisteredTool => ({
      name,
      effects: effects ?? [],
      inputSchema: { type: "object" },
      validate: object,
      execute: async (args, context) => {
        await this.authorize();
        context.signal?.throwIfAborted();
        return run(args, context);
      },
    });
    return [
      tool("plan_authorize", ["read"], async () => ({
        status: "success",
        structuredContent: { authorized: true },
      })),
      tool("plan_snapshot", ["read"], async () => ({
        status: "success",
        structuredContent: json(this.snapshot()),
      })),
      ...operations.map((op) =>
        tool(op, ["read", "write"], async (args) => {
          if (
            Object.keys(args).length !== 1 ||
            args.orderId !== this.request.orderId
          )
            throw new Error("Operation scope mismatch");
          try {
            const result = this.operate(op);
            if (
              op.startsWith("ship_") &&
              !result.replayed &&
              this.db.prepare("SELECT scenario FROM config").get()!.scenario ===
                "lost-response"
            )
              return {
                status: "unknown",
                error: {
                  code: "OUTCOME_UNKNOWN",
                  message:
                    "Shipment response lost. Refresh state before planning remaining work.",
                  retryable: false,
                },
              };
            const data = await this.record(op, result.data);
            if (op === "read_receipt")
              await immutable(
                join(this.directory, "shipment.json"),
                JSON.stringify(result.data, null, 2),
              );
            return { status: "success", structuredContent: json(data) };
          } catch (e) {
            if (e instanceof Error && e.message === "ENVIRONMENT_CHANGED")
              return {
                status: "failed",
                error: {
                  code: "ENVIRONMENT_CHANGED",
                  message:
                    "Preconditions or carrier prices changed; refresh state and replan remaining steps.",
                  retryable: false,
                },
              };
            throw e;
          }
        }),
      ),
      tool("plan_check", ["read"], async (args) => {
        const step = args.step as unknown as Step,
          e = await this.evidence(String(args.evidenceId)),
          data = object(e.data);
        if (
          !operations.includes(step.tool) ||
          e.tool !== step.tool ||
          data.state !== step.expected
        )
          throw new Error("Step result mismatch");
        const key = step.tool.startsWith("ship_") ? "shipment" : step.tool;
        if (
          this.db.prepare("SELECT result FROM operations WHERE id=?").get(key)
            ?.result !== JSON.stringify(data)
        )
          throw new Error("Business receipt mismatch");
        return { status: "success", structuredContent: { verified: true } };
      }),
      tool("plan_publish", ["read", "write"], async (args) => {
        const out = await this.validateReport(args.report);
        // Replay publishes a verified snapshot; it never books another shipment.
        await mkdir(join(this.directory, "output"), { recursive: true });
        await immutable(
          join(this.directory, "output/report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const lines = [
          "# Plan-and-Execute",
          "",
          `Status: ${out.status}`,
          `Stop: ${out.stopReason}`,
          "",
          ...out.plans.flatMap((p) => [
            `## Plan ${p.version}`,
            "",
            ...p.plan.steps.map((s) => `- ${s.id}: ${s.tool} → ${s.expected}`),
            "",
          ]),
          "## Verified result",
          "",
          out.receipt
            ? `Order ${out.receipt.orderId}; ${out.receipt.quantity} items; ${out.receipt.carrier}; ${out.receipt.cost} cents; ${out.receipt.tracking}.`
            : "No completed shipment result has been verified.",
          "",
          ...out.completed.map((c) => `- ${c.step.tool}: ${c.evidenceId}`),
        ];
        await immutable(
          join(this.directory, "output/report.md"),
          lines.join("\n") + "\n",
        );
        return { status: "success", structuredContent: { published: true } };
      }),
    ];
  }
}
