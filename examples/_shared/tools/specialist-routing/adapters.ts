import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import { original, patched, tests } from "./code-fixture.ts";
import {
  request,
  sources,
  evidence,
  route,
  plan,
  answer,
  hash,
  idOf,
  type Request,
  type Sources,
  type Route,
  type Receipt,
  type Result,
  type Report,
  type Specialist,
} from "./domain.ts";
const codeDigest = digest(original + patched + tests);
async function file(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 1000000)
    throw new Error("Invalid task file");
  return readFile(path, "utf8");
}
async function optional(path: string) {
  try {
    return await file(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export const questions = {
  finance: "请按照报销规则计算 EXP-204 的可报销金额和超额金额。",
  legal:
    "请依据内部检查表审查合同 CONTRACT-204 的终止通知期及数据返还条款，列出遗漏。",
  data: "请查询 sales 数据库，统计已支付订单数、销售总额及各地区销售额，排除取消订单。",
  coding:
    "请修复 discount.mjs 把基点误当百分比的缺陷，运行测试并给出修改结果。",
  ambiguous: "请同时审查合同条款并修复折扣函数。",
  unsupported: "请告诉我明天的天气。",
} as const;
export type Scenario = keyof typeof questions;
export async function createDemo(
  directory: string,
  overrides: Partial<Omit<Request, "sourceDigest">> = {},
  scenario: Scenario = "data",
) {
  if (!(scenario in questions)) throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const s: Sources = {
    codeDigest,
    finance: {
      claimId: "EXP-204",
      mealCents: 58000,
      travelCents: 12000,
      mealCapCents: 50000,
    },
    legal: {
      contractId: "CONTRACT-204",
      noticeDays: 30,
      requiredNoticeDays: 30,
      dataReturnDays: null,
    },
    data: [
      { id: "S1", region: "north", cents: 120000, status: "paid" },
      { id: "S2", region: "south", cents: 80000, status: "paid" },
      { id: "S3", region: "north", cents: 40000, status: "paid" },
      { id: "S4", region: "south", cents: 50000, status: "cancelled" },
    ],
  };
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    question: questions[scenario],
    sourceDigest: idOf(s),
    allowedRoles: ["finance", "legal", "data", "coding"],
    minConfidence: 0.75,
    maxModelCalls: 10,
    maxAttempts: 2,
    deadlineSeconds: 600,
    ...overrides,
  });
  await immutable(join(directory, "sources.json"), JSON.stringify(s));
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  const db = new DatabaseSync(join(directory, "sales.sqlite"));
  try {
    db.exec(
      "CREATE TABLE sales (id TEXT PRIMARY KEY, region TEXT NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO sales VALUES (?, ?, ?, ?)");
    for (const x of s.data) insert.run(x.id, x.region, x.cents, x.status);
  } finally {
    db.close();
  }
  await mkdir(join(directory, "input-code"), { recursive: true });
  await immutable(join(directory, "input-code/discount.mjs"), original);
  await immutable(join(directory, "input-code/discount.test.mjs"), tests);
  return r;
}
interface SavedRoute {
  requestDigest: string;
  route: Route;
}
async function runTests(dir: string, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--test", "--test-reporter=tap", "discount.test.mjs"],
      {
        cwd: dir,
        env: {},
        timeout: 10000,
        maxBuffer: 256000,
        ...(signal ? { signal } : {}),
      },
      (error, stdout) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(error);
          return;
        }
        resolve({ code: (error?.code as number) ?? 0, stdout });
      },
    );
  });
}
export class RoutingAdapters {
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
      policy = object(
        JSON.parse(await file(join(this.directory, "policy.json"))),
      );
    if (JSON.stringify(r) !== JSON.stringify(this.request))
      throw new Error("Task request changed");
    if (
      policy.enabled !== true ||
      !Array.isArray(policy.principals) ||
      !policy.principals.includes(r.principal)
    )
      throw new Error("Permission revoked");
    const s = sources(
      JSON.parse(await file(join(this.directory, "sources.json"))),
    );
    if (idOf(s) !== r.sourceDigest || s.codeDigest !== codeDigest)
      throw new Error("Source changed");
    return s;
  }
  async selected(id: unknown): Promise<SavedRoute> {
    const raw = await file(join(this.directory, "route.json")),
      saved = JSON.parse(raw) as SavedRoute;
    await this.load();
    if (
      digest(raw) !== hash(id) ||
      saved.requestDigest !== idOf(this.request) ||
      JSON.stringify(route(saved.route, this.request)) !==
        JSON.stringify(saved.route)
    )
      throw new Error("Route binding changed");
    return saved;
  }
  private async scoped(id: unknown, role: unknown) {
    const selected = await this.selected(id);
    if (
      selected.route.status !== "selected" ||
      selected.route.selected !== role ||
      !this.request.allowedRoles.includes(role as Specialist)
    )
      throw new Error("Specialist is not authorized by the route");
    return evidence(await this.load(), role as Specialist);
  }
  async receipt(id: unknown): Promise<Receipt> {
    const raw = await file(join(this.directory, "receipt.json")),
      r = JSON.parse(raw) as Receipt;
    if (digest(raw) !== hash(id) || r.requestDigest !== idOf(this.request))
      throw new Error("Receipt binding changed");
    plan(r.plan, await this.scoped(r.routeId, r.plan.role));
    if (r.result.role !== r.plan.role) throw new Error("Receipt role mismatch");
    for (const a of r.artifacts) {
      if (
        ![
          "result.json",
          "sales.csv",
          "solution/discount.mjs",
          "solution/discount.test.mjs",
          "baseline-tests.txt",
          "patched-tests.txt",
        ].includes(a.path) ||
        digest(await file(join(this.directory, a.path))) !== a.digest
      )
        throw new Error("Artifact changed");
    }
    if (!r.artifacts.some((a) => a.path === "result.json"))
      throw new Error("Missing result artifact");
    if (
      JSON.stringify(
        JSON.parse(await file(join(this.directory, "result.json"))),
      ) !== JSON.stringify(r.result)
    )
      throw new Error("Result changed");
    return r;
  }
  private async performOperation(
    role: Specialist,
    signal?: AbortSignal,
  ): Promise<{ result: Result; paths: string[] }> {
    const s = await this.load(),
      paths: string[] = [];
    let values: Result["values"], facts: Result["facts"];
    if (role === "finance") {
      const f = s.finance,
        submittedCents = f.mealCents + f.travelCents,
        approvedCents = Math.min(f.mealCents, f.mealCapCents) + f.travelCents;
      values = {
        submittedCents,
        approvedCents,
        excessCents: submittedCents - approvedCents,
      };
      facts = [
        ...evidence(s, role).facts,
        {
          id: "calculation",
          quote: `Submitted ${submittedCents} cents; approved ${approvedCents} cents; excess ${submittedCents - approvedCents} cents.`,
        },
      ];
    } else if (role === "legal") {
      const l = s.legal;
      values = {
        noticeCompliant: l.noticeDays >= l.requiredNoticeDays,
        dataReturnMissing: l.dataReturnDays === null,
      };
      facts = [
        ...evidence(s, role).facts,
        {
          id: "review",
          quote: `Notice compliant: ${values.noticeCompliant}; data return deadline missing: ${values.dataReturnMissing}.`,
        },
      ];
    } else if (role === "data") {
      const db = new DatabaseSync(join(this.directory, "sales.sqlite"), {
        readOnly: true,
      });
      try {
        db.exec("BEGIN");
        const rows = db
          .prepare("SELECT id,region,cents,status FROM sales ORDER BY id")
          .all();
        if (
          idOf(rows) !==
          idOf([...s.data].sort((a, b) => a.id.localeCompare(b.id)))
        )
          throw new Error("Sales dataset changed");
        const groups = db
          .prepare(
            "SELECT region, count(*) AS orders, sum(cents) AS cents FROM sales WHERE status='paid' GROUP BY region ORDER BY region",
          )
          .all();
        const paidOrders = groups.reduce((n, x) => n + Number(x.orders), 0),
          revenueCents = groups.reduce((n, x) => n + Number(x.cents), 0);
        values = {
          paidOrders,
          revenueCents,
          regions: groups.map((x) => ({
            region: String(x.region),
            orders: Number(x.orders),
            cents: Number(x.cents),
          })),
        };
        facts = [
          {
            id: "query",
            quote:
              "Count and sum paid sales grouped by region; cancelled orders excluded.",
          },
          { id: "result", quote: JSON.stringify(values) },
        ];
        await immutable(
          join(this.directory, "sales.csv"),
          "region,orders,cents\n" +
            groups.map((x) => `${x.region},${x.orders},${x.cents}`).join("\n") +
            "\n",
        );
        paths.push("sales.csv");
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    } else {
      if (
        (await file(join(this.directory, "input-code/discount.mjs"))) !==
          original ||
        (await file(join(this.directory, "input-code/discount.test.mjs"))) !==
          tests
      )
        throw new Error("Code input changed");
      const baseline = await runTests(
        join(this.directory, "input-code"),
        signal,
      );
      if (baseline.code === 0 || !baseline.stdout.includes("# fail 2"))
        throw new Error("Expected regression was not reproduced");
      await mkdir(join(this.directory, "solution"), { recursive: true });
      await immutable(join(this.directory, "solution/discount.mjs"), patched);
      await immutable(
        join(this.directory, "solution/discount.test.mjs"),
        tests,
      );
      const fixed = await runTests(join(this.directory, "solution"), signal);
      if (fixed.code !== 0 || !fixed.stdout.includes("# pass 3"))
        throw new Error("Patch tests failed");
      // Test output includes timing; preserve the first successful logs for idempotent retries.
      for (const [name, body] of [
        ["baseline-tests.txt", baseline.stdout],
        ["patched-tests.txt", fixed.stdout],
      ] as const) {
        if ((await optional(join(this.directory, name))) === null)
          await immutable(join(this.directory, name), body);
        paths.push(name);
      }
      paths.push("solution/discount.mjs", "solution/discount.test.mjs");
      values = {
        baselineFailed: 2,
        patchedPassed: 3,
        patchedFailed: 0,
        exampleCents: 8500,
      };
      facts = [
        ...evidence(s, role).facts,
        {
          id: "tests",
          quote:
            "Baseline: 2 failing tests. Patched: 3 passing tests, 0 failing tests.",
        },
      ];
    }
    signal?.throwIfAborted();
    const result: Result = { role, values, facts };
    await immutable(
      join(this.directory, "result.json"),
      JSON.stringify(result),
    );
    paths.push("result.json");
    return { result, paths };
  }
  async verify(report: Report) {
    await this.load();
    if (report.requestId !== this.request.id)
      throw new Error("Report scope mismatch");
    const raw = await optional(join(this.directory, "route.json"));
    if (
      report.route &&
      (!raw ||
        JSON.stringify((await this.selected(digest(raw))).route) !==
          JSON.stringify(report.route))
    )
      throw new Error("Report route mismatch");
    if (report.receiptId) {
      const receipt = await this.receipt(report.receiptId);
      if (report.route?.selected !== receipt.plan.role)
        throw new Error("Report specialist mismatch");
      if (report.answer) answer(report.answer, receipt.result);
    }
    if (report.status === "completed") {
      if (
        !report.receiptId ||
        !report.answer ||
        report.route?.status !== "selected"
      )
        throw new Error("Missing task result");
    } else if (report.answer !== null) throw new Error("Unexpected answer");
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
      tool("routing_authorize", async () => ok({ authorized: true })),
      tool("routing_save", async (a) => {
        let r;
        try {
          r = route(a.route, this.request);
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_ROUTE",
              message: "Route failed validation",
            },
          };
        }
        const saved: SavedRoute = {
          requestDigest: idOf(this.request),
          route: r,
        };
        await immutable(
          join(this.directory, "route.json"),
          JSON.stringify(saved),
        );
        return ok({ routeId: idOf(saved), route: r });
      }),
      tool("routing_read", async (a) =>
        ok(await this.scoped(a.routeId, a.role)),
      ),
      tool("routing_execute", async (a, c) => {
        const e = await this.scoped(a.routeId, a.role);
        if (object(a.plan).matchesRequest === false)
          return {
            status: "failed",
            error: {
              code: "ROUTE_MISMATCH",
              message:
                "The selected specialist reports that the user request is outside its task scope.",
            },
          };
        let p;
        try {
          p = plan(a.plan, e);
        } catch {
          return {
            status: "failed",
            error: {
              code: "INVALID_PLAN",
              message: "Specialist plan failed validation",
            },
          };
        }
        const prior = await optional(join(this.directory, "receipt.json"));
        if (prior) {
          const receipt = await this.receipt(digest(prior));
          if (JSON.stringify(receipt.plan) !== JSON.stringify(p))
            throw new Error("Operation replay differs");
          return ok({ receiptId: digest(prior), receipt });
        }
        const executed = await this.performOperation(e.role, c.signal),
          artifacts = [];
        for (const path of executed.paths)
          artifacts.push({
            path,
            digest: digest(await file(join(this.directory, path))),
          });
        const receipt: Receipt = {
          requestDigest: idOf(this.request),
          routeId: hash(a.routeId),
          plan: p,
          result: executed.result,
          artifacts,
        };
        await immutable(
          join(this.directory, "receipt.json"),
          JSON.stringify(receipt),
        );
        return ok({ receiptId: idOf(receipt), receipt });
      }),
      tool("routing_result", async (a) => ok(await this.receipt(a.receiptId))),
      tool("routing_publish", async (a) => {
        const report = a.report as unknown as Report;
        await this.verify(report);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        await immutable(
          join(dir, "report.md"),
          `# Specialist routing\n\nStatus: ${report.status}\nStop: ${report.stopReason}\nSelected: ${report.route?.selected ?? "none"}\n\n${report.route?.reason ?? "No accepted route."}\n\n${report.clarification ?? ""}\n\n${report.answer?.summary ?? "No completed specialist answer."}\n\n` +
            (report.answer?.citations
              .map((c) => `- ${c.id}: ${c.quote}`)
              .join("\n") ?? "") +
            "\n",
        );
        return ok({ published: true });
      }),
    ];
  }
}
