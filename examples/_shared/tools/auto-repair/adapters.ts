import { mkdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { immutable } from "../execution/files.ts";
import { digest, json, object } from "../evidence.ts";
import {
  request,
  content,
  hash,
  idOf,
  patch,
  type Request,
  type Revision,
  type Run,
  type Execution,
  type Report,
} from "./domain.ts";
import {
  contract,
  tests,
  workflow,
  records,
  expectedRows,
  csv,
} from "./fixtures.ts";
export type Scenario =
  | "code"
  | "sql"
  | "config"
  | "already-correct"
  | "missing-input";
const fixtureDigest = idOf({ contract, tests, workflow, records, csv });
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
function artifact(r: Request, expression: string) {
  return r.kind === "code"
    ? `export function discount(amountCents, discountBps) { return ${expression}; }\n`
    : expression;
}
export const filename = (r: Request) =>
  r.kind === "code"
    ? "discount.mjs"
    : r.kind === "sql"
      ? "query.sql"
      : "config.json";
export async function createDemo(
  directory: string,
  overrides: Partial<Omit<Request, "sourceDigest" | "kind">> = {},
  scenario: Scenario = "code",
) {
  if (
    !["code", "sql", "config", "already-correct", "missing-input"].includes(
      scenario,
    )
  )
    throw new Error("Invalid scenario");
  await mkdir(directory, { recursive: true });
  const kind =
    scenario === "sql"
      ? "sql"
      : ["config", "missing-input"].includes(scenario)
        ? "config"
        : "code";
  const initial =
    kind === "code"
      ? scenario === "already-correct"
        ? "Math.round(amountCents * (1 - discountBps / 10000))"
        : "Math.round(amountCents * (1 - discountBps / 100))"
      : kind === "sql"
        ? "SELECT region, SUM(amount_cents) AS totalCents FROM orders WHERE status = 'paid' GROUP BY region ORDER BY region"
        : JSON.stringify({
            delimiter: ";",
            amountColumn: "cents",
            statusFilter: "paid",
          });
  const source = {
    kind,
    initial,
    fixtureDigest,
    missingInput: scenario === "missing-input",
  };
  const r = request({
    id: randomUUID(),
    tenant: "demo",
    principal: "operator",
    question:
      "执行当前任务，根据真实错误反馈修复并重新验证；保留失败记录和最终修复产物。",
    kind,
    maxModelCalls: 6,
    maxExecutions: 4,
    maxAttempts: 2,
    deadlineSeconds: 600,
    ...overrides,
    sourceDigest: idOf(source),
  });
  await immutable(join(directory, "request.json"), JSON.stringify(r, null, 2));
  await immutable(join(directory, "sources.json"), JSON.stringify(source));
  await immutable(
    join(directory, "policy.json"),
    JSON.stringify({ enabled: true, principals: [r.principal] }),
  );
  await mkdir(join(directory, "input"), { recursive: true });
  await immutable(join(directory, "input", filename(r)), artifact(r, initial));
  await immutable(join(directory, "input/discount.test.mjs"), tests);
  await immutable(join(directory, "input/workflow.mjs"), workflow);
  if (!source.missingInput)
    await immutable(join(directory, "input/orders.csv"), csv);
  const db = new DatabaseSync(join(directory, "orders.sqlite"));
  try {
    db.exec(
      "CREATE TABLE orders(id TEXT PRIMARY KEY, region TEXT NOT NULL, cents INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    const insert = db.prepare("INSERT INTO orders VALUES(?,?,?,?)");
    for (const x of records) insert.run(x.id, x.region, x.cents, x.status);
  } finally {
    db.close();
  }
  return r;
}
async function processRun(dir: string, args: string[], signal?: AbortSignal) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: dir,
        env: {},
        timeout: 10000,
        maxBuffer: 256000,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error && typeof error.code !== "number" && !error.killed) {
          reject(error);
          return;
        }
        resolve({
          code: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout,
          stderr,
          timedOut: !!error?.killed,
        });
      },
    );
  });
}
export class RepairAdapters {
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
    const s = object(
      JSON.parse(await file(join(this.directory, "sources.json"))),
    );
    if (
      idOf(s) !== r.sourceDigest ||
      s.fixtureDigest !== fixtureDigest ||
      s.kind !== r.kind
    )
      throw new Error("Source changed");
    if (
      (await file(join(this.directory, "input", filename(r)))) !==
        artifact(r, String(s.initial)) ||
      (await file(join(this.directory, "input/discount.test.mjs"))) !== tests ||
      (await file(join(this.directory, "input/workflow.mjs"))) !== workflow
    )
      throw new Error("Trusted input changed");
    const data = await optional(join(this.directory, "input/orders.csv"));
    if ((data !== null && data !== csv) || (data === null && !s.missingInput))
      throw new Error("Data changed");
    const db = new DatabaseSync(join(this.directory, "orders.sqlite"), {
      readOnly: true,
    });
    try {
      const rows = db
        .prepare("SELECT id,region,cents,status FROM orders ORDER BY id")
        .all();
      if (JSON.stringify(rows) !== JSON.stringify(records))
        throw new Error("Database source changed");
    } finally {
      db.close();
    }
    return s;
  }
  async storeRevision(v: Revision) {
    const id = idOf(v),
      dir = join(this.directory, "revisions", id);
    await mkdir(dir, { recursive: true });
    await immutable(join(dir, "revision.json"), JSON.stringify(v));
    await immutable(
      join(dir, filename(this.request)),
      artifact(this.request, v.content),
    );
    return id;
  }
  async revision(id: string): Promise<Revision> {
    hash(id);
    const raw = await file(
        join(this.directory, "revisions", id, "revision.json"),
      ),
      v = JSON.parse(raw) as Revision;
    if (
      digest(raw) !== id ||
      v.requestDigest !== idOf(this.request) ||
      content(this.request.kind, v.content) !== v.content ||
      (await file(
        join(this.directory, "revisions", id, filename(this.request)),
      )) !== artifact(this.request, v.content)
    )
      throw new Error("Revision integrity failure");
    return v;
  }
  async execution(id: string): Promise<Run | null> {
    await this.revision(id);
    const raw = await optional(
      join(this.directory, "revisions", id, "execution.json"),
    );
    if (!raw) return null;
    const e = JSON.parse(raw) as Execution;
    if (
      e.revisionId !== id ||
      (e.status === "passed" &&
        (e.exitCode !== 0 ||
          e.errorCode !== null ||
          !e.checks.length ||
          e.checks.some((c) => !c.passed)))
    )
      throw new Error("Execution binding changed");
    const dir = join(this.directory, "revisions", id);
    if (
      this.request.kind === "code" &&
      (await file(join(dir, "discount.test.mjs"))) !== tests
    )
      throw new Error("Test file changed");
    if (
      this.request.kind === "config" &&
      e.errorCode !== "MISSING_INPUT" &&
      ((await file(join(dir, "workflow.mjs"))) !== workflow ||
        (await file(join(dir, "orders.csv"))) !== csv)
    )
      throw new Error("Workflow input changed");
    return { ...e, id: digest(raw) };
  }
  async performOperation(id: string, signal?: AbortSignal): Promise<Run> {
    const source = await this.load(),
      v = await this.revision(id),
      cached = await this.execution(id);
    if (cached) return cached;
    signal?.throwIfAborted();
    const dir = join(this.directory, "revisions", id);
    let result: Execution;
    if (this.request.kind === "sql") {
      const db = new DatabaseSync(join(this.directory, "orders.sqlite"), {
        readOnly: true,
      });
      try {
        const rows = db.prepare(v.content).all(),
          passed = JSON.stringify(rows) === JSON.stringify(expectedRows);
        result = {
          revisionId: id,
          status: passed ? "passed" : "failed",
          errorCode: passed ? null : "RESULT_MISMATCH",
          exitCode: 0,
          stdout: JSON.stringify(rows),
          stderr: passed
            ? ""
            : "Expected paid-only grouped totals; actual rows do not match the immutable acceptance data.",
          checks: [{ name: "paid-order-totals", passed }],
        };
      } catch (e) {
        result = {
          revisionId: id,
          status: "failed",
          errorCode: "SQL_ERROR",
          exitCode: 1,
          stdout: "",
          stderr: e instanceof Error ? e.message : String(e),
          checks: [{ name: "query-execution", passed: false }],
        };
      } finally {
        db.close();
      }
    } else if (this.request.kind === "config" && source.missingInput) {
      result = {
        revisionId: id,
        status: "blocked",
        errorCode: "MISSING_INPUT",
        exitCode: null,
        stdout: "",
        stderr:
          "orders.csv is absent; a configuration edit cannot reconstruct missing source data.",
        checks: [{ name: "input-present", passed: false }],
      };
    } else {
      if (this.request.kind === "code")
        await immutable(join(dir, "discount.test.mjs"), tests);
      else {
        await immutable(join(dir, "workflow.mjs"), workflow);
        await immutable(join(dir, "orders.csv"), csv);
      }
      const p = await processRun(
        dir,
        this.request.kind === "code"
          ? ["--test", "--test-reporter=tap", "discount.test.mjs"]
          : ["workflow.mjs"],
        signal,
      );
      let passed = p.code === 0;
      if (this.request.kind === "config" && passed) {
        try {
          passed = isDeepStrictEqual(JSON.parse(p.stdout), expectedRows);
        } catch {
          passed = false;
        }
      }
      result = {
        revisionId: id,
        status: p.timedOut ? "blocked" : passed ? "passed" : "failed",
        errorCode: p.timedOut
          ? "EXECUTION_TIMEOUT"
          : passed
            ? null
            : p.code === 0
              ? "RESULT_MISMATCH"
              : "EXECUTION_ERROR",
        exitCode: p.code,
        stdout: p.stdout,
        stderr:
          p.stderr +
          (p.code === 0 && !passed
            ? "\nExpected paid-only grouped totals; output differs."
            : ""),
        checks: [
          {
            name:
              this.request.kind === "code"
                ? "trusted-discount-tests"
                : "paid-order-workflow",
            passed,
          },
        ],
      };
    }
    await immutable(join(dir, "execution.json"), JSON.stringify(result));
    return { ...result, id: idOf(result) };
  }
  async verify(out: Report) {
    const source = await this.load();
    let prior: Run | undefined;
    if (
      out.requestId !== this.request.id ||
      out.runs.length > this.request.maxExecutions
    )
      throw new Error("Invalid report identity");
    for (const e of out.runs) {
      const actual = await this.execution(e.revisionId),
        v = await this.revision(e.revisionId);
      if (!isDeepStrictEqual(e, actual))
        throw new Error("Execution evidence changed");
      if (!prior) {
        if (
          v.parentId !== null ||
          v.patch !== null ||
          v.content !== source.initial
        )
          throw new Error("Invalid baseline");
      } else {
        if (v.parentId !== prior.revisionId || !v.patch)
          throw new Error("Broken repair chain");
        patch(
          v.patch,
          this.request.kind,
          prior.revisionId,
          prior,
          (await this.revision(prior.revisionId)).content,
        );
        if (v.content !== v.patch.content)
          throw new Error("Patch content mismatch");
      }
      prior = e;
    }
    if (out.status === "completed") {
      if (
        !prior ||
        prior.status !== "passed" ||
        out.acceptedRevisionId !== prior.revisionId
      )
        throw new Error("Unverified repair cannot complete");
    } else if (out.acceptedRevisionId !== null)
      throw new Error("Unverified accepted revision");
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
      tool("repair_load", async () => {
        const s = await this.load();
        const revisionId = await this.storeRevision({
          requestDigest: idOf(this.request),
          parentId: null,
          content: content(this.request.kind, s.initial),
          patch: null,
        });
        return ok({
          revisionId,
          contract: contract[this.request.kind],
          schema:
            this.request.kind === "sql"
              ? "orders(id TEXT, region TEXT, cents INTEGER, status TEXT)"
              : null,
        });
      }),
      tool("repair_inspect", async (a) => {
        const id = hash(a.revisionId);
        return ok({
          revision: await this.revision(id),
          execution: await this.execution(id),
        });
      }),
      tool("repair_run", async (a, c) =>
        ok(await this.performOperation(hash(a.revisionId), c.signal)),
      ),
      tool("repair_apply", async (a) => {
        const base = hash(a.baseRevisionId),
          previous = await this.revision(base),
          failed = await this.execution(base);
        if (!failed) throw new Error("No execution feedback");
        let p;
        try {
          p = patch(a.patch, this.request.kind, base, failed, previous.content);
        } catch (e) {
          return {
            status: "failed",
            error: {
              code: "INVALID_PATCH",
              message: e instanceof Error ? e.message : String(e),
            },
          };
        }
        const id = await this.storeRevision({
          requestDigest: idOf(this.request),
          parentId: base,
          content: p.content,
          patch: p,
        });
        return ok({ revisionId: id });
      }),
      tool("repair_publish", async (a) => {
        const out = a.report as unknown as Report;
        await this.verify(out);
        const dir = join(this.directory, "output");
        await mkdir(dir, { recursive: true });
        await immutable(
          join(dir, "report.json"),
          JSON.stringify(out, null, 2) + "\n",
        );
        const lines = [
          "# Automatic repair",
          `Status: ${out.status}`,
          `Stop: ${out.stopReason}`,
          `Accepted revision: ${out.acceptedRevisionId ?? "none"}`,
        ];
        for (const run of out.runs) {
          const v = await this.revision(run.revisionId);
          lines.push(
            `## Execution ${run.id}`,
            `Revision: ${run.revisionId}`,
            `Result: ${run.status} (${run.errorCode ?? "OK"})`,
            ...(v.patch
              ? [
                  `Diagnosis: ${v.patch.diagnosis}`,
                  `Change: ${v.patch.changeSummary}`,
                ]
              : ["Original input"]),
            "```text",
            run.stdout,
            run.stderr,
            "```",
          );
        }
        if (out.acceptedRevisionId) {
          const v = await this.revision(out.acceptedRevisionId);
          await immutable(
            join(dir, filename(this.request)),
            artifact(this.request, v.content),
          );
          const run = out.runs.at(-1)!;
          if (this.request.kind !== "code")
            await immutable(join(dir, "rows.json"), run.stdout.trim() + "\n");
        }
        await immutable(join(dir, "report.md"), lines.join("\n\n") + "\n");
        return ok({ directory: dir, status: out.status });
      }),
    ];
  }
}
