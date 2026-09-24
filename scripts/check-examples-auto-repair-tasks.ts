import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { contextScopeKey } from "@ditto/core/worker/context";
import type { WorkerDefinition } from "@ditto/core/worker";
import {
  createDemo,
  filename,
  type Scenario,
} from "../examples/_shared/tools/auto-repair/adapters.ts";
import { type Report } from "../examples/_shared/tools/auto-repair/domain.ts";
import {
  runRepairLoop,
  scope,
  type Options,
} from "../examples/patterns/auto-repair/index.ts";
import { observedRepair } from "./fixtures/auto-repair-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-auto-repair-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-auto-repair-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model;
assert.ok(model);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-"));
const cases = [
  "code",
  "sql",
  "config",
  "already-correct",
  "missing-input",
  "two-rounds",
  "sql-semantic-repair",
  "config-semantic-repair",
  "invalid-json-retry",
  "model-failure",
  "patch-exhausted",
  "unsafe-code",
  "unsafe-sql",
  "wrong-execution",
  "wrong-base",
  "no-change",
  "max-model-calls",
  "max-executions",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "revision-tampered",
  "execution-tampered",
  "tests-tampered",
  "database-tampered",
  "cancelled",
  "cancel-after-apply",
  "execution-crash",
  "effect-crash",
  "sample-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario: Scenario =
      name.startsWith("sql") || name === "unsafe-sql"
        ? "sql"
        : name.startsWith("config")
          ? "config"
          : name === "already-correct" || name === "missing-input"
            ? name
            : "code";
  const r = await createDemo(
    dir,
    {
      maxModelCalls: name === "max-model-calls" ? 1 : 6,
      maxExecutions: name === "max-executions" ? 2 : 4,
      deadlineSeconds: name === "deadline" ? 1 : 600,
    },
    scenario,
  );
  const input = { request: r, model: { provider: provider!, model: model! } },
    spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    controller = new AbortController();
  let calls = 0,
    injected = 0;
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, args, context) {
          spans.push(node);
          const out = await w.execute(node, args, context);
          if (
            node === "INTERACTION.ACT.TOOL" &&
            name === "cancel-after-apply" &&
            !injected &&
            JSON.stringify(args).includes('"repair_apply"')
          ) {
            injected++;
            controller.abort();
          }
          if (node !== "INFER.REASONING.SAMPLE") return out;
          calls++;
          const data = JSON.parse(
            (args as { messages: { content: string }[] }).messages.at(-1)!
              .content,
          );
          assert.equal(data.execution.status, "failed");
          assert.equal(data.execution.revisionId, data.revisionId);
          assert.ok(data.execution.stderr || data.execution.stdout);
          await writeFile(
            join(dir, `model-${calls}.json`),
            JSON.stringify({ input: args, output: out }, null, 2),
          );
          const changed = structuredClone(out) as {
            output: { message: { content: string } };
          };
          if (name === "model-failure" && !injected) {
            injected++;
            return {
              status: "failed",
              error: {
                code: "INJECTED_PROVIDER_FAILURE",
                message: "test provider failure",
              },
            };
          }
          if (
            (name === "invalid-json-retry" && !injected) ||
            name === "patch-exhausted"
          ) {
            injected++;
            changed.output.message.content = "invalid repair JSON";
            return changed;
          }
          const invalid = [
            "unsafe-code",
            "unsafe-sql",
            "wrong-execution",
            "wrong-base",
            "no-change",
          ].includes(name);
          const wrong =
            [
              "two-rounds",
              "sql-semantic-repair",
              "config-semantic-repair",
              "max-model-calls",
              "max-executions",
            ].includes(name) && !injected;
          if (invalid || wrong) {
            const p = {
              baseRevisionId: data.revisionId,
              executionId: data.execution.id,
              diagnosis: "Injected faulty proposal to test actual recovery",
              changeSummary: "Test mutation",
              content: data.current,
            };
            if (wrong)
              p.content =
                r.kind === "code"
                  ? "Math.round(amountCents * (1 - discountBps / 1000))"
                  : r.kind === "sql"
                    ? "SELECT region, SUM(cents) AS totalCents FROM orders GROUP BY region ORDER BY region"
                    : JSON.stringify({
                        delimiter: ",",
                        amountColumn: "cents",
                        statusFilter: "all",
                      });
            if (name === "unsafe-code") p.content = "process.exit(0)";
            if (name === "unsafe-sql") p.content = "DROP TABLE orders";
            if (name === "wrong-execution") p.executionId = "0".repeat(64);
            if (name === "wrong-base") p.baseRevisionId = "0".repeat(64);
            if (["wrong-execution", "wrong-base"].includes(name))
              p.content = "Math.round(amountCents * (1 - discountBps / 10000))";
            changed.output.message.content = JSON.stringify(p);
            injected++;
            return changed;
          }
          return out;
        },
        async dispose() {
          await w.dispose?.();
        },
      };
    },
  });
  let app: Awaited<ReturnType<typeof observedRepair>> | undefined;
  const open = async () => {
    app = await observedRepair(dir, r, config, observe);
  };
  const run = (options: Options = {}) =>
    app!.runtime.loop(runRepairLoop, [input, options], {
      ...(options.signal ? { signal: options.signal } : {}),
      onGraph: (e) => {
        if (e.status === "started") graphs.push(e.graphId);
      },
    });
  async function child(phase: string) {
    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/auto-repair-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
          "--provider",
          provider!,
        ],
        { env: process.env },
      );
      let stderr = "";
      p.stderr.on("data", (b) => (stderr += b));
      p.on("error", reject);
      p.on("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    if (phase.endsWith("-crash"))
      assert.equal(outcome.signal, "SIGKILL", outcome.stderr);
    else assert.equal(outcome.code, 0, outcome.stderr);
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  try {
    let result: Report;
    if (name.endsWith("-crash")) {
      await child(name);
      await child("continue");
      await open();
      result = (await run()) as Report;
    } else {
      await open();
      if (name === "cancelled") {
        controller.abort();
        await assert.rejects(run({ signal: controller.signal }));
        assert.equal(spans.length, 0);
      }
      if (name === "cancel-after-apply")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "deadline",
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "request-changed",
          "source-changed",
          "permission-revoked",
          "revision-tampered",
          "execution-tampered",
          "tests-tampered",
          "database-tampered",
        ].includes(name)
      ) {
        await run({ stopAfter: name === "deadline" ? "execution" : "patch" });
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          await app!.storage.redis.pExpire(
            (config.context.cache?.keyPrefix ?? "ditto:context:") +
              contextScopeKey(scope(r)),
            1,
          );
          await delay(10);
        }
        if (name === "redis-unavailable") {
          await app!.storage.redis.quit();
          const n = calls;
          await assert.rejects(run());
          assert.equal(calls, n);
          await app!.close();
          await open();
        }
        if (name === "memory-unavailable") {
          const db = new DatabaseSync(join(dir, "memory.sqlite"));
          try {
            db.exec("ALTER TABLE memories RENAME TO unavailable");
            await assert.rejects(run());
          } finally {
            db.exec("ALTER TABLE unavailable RENAME TO memories");
            db.close();
          }
        }
        if (
          [
            "request-changed",
            "source-changed",
            "permission-revoked",
            "revision-tampered",
            "execution-tampered",
            "tests-tampered",
          ].includes(name)
        ) {
          const revisions = await readdir(join(dir, "revisions"));
          let path = join(
            dir,
            name === "request-changed"
              ? "request.json"
              : name === "source-changed"
                ? "sources.json"
                : "policy.json",
          );
          if (name === "revision-tampered")
            path = join(dir, "revisions", revisions[0]!, filename(r));
          if (name === "execution-tampered" || name === "tests-tampered") {
            let baseline = "";
            for (const id of revisions) {
              const v = JSON.parse(
                await readFile(
                  join(dir, "revisions", id, "revision.json"),
                  "utf8",
                ),
              );
              if (v.parentId === null) baseline = id;
            }
            path = join(
              dir,
              "revisions",
              baseline,
              name === "execution-tampered"
                ? "execution.json"
                : "discount.test.mjs",
            );
          }
          const old = await readFile(path, "utf8");
          let changed = old + "tamper";
          if (name === "request-changed") {
            const v = JSON.parse(old);
            v.question += " changed";
            changed = JSON.stringify(v);
          }
          if (name === "source-changed") {
            const v = JSON.parse(old);
            v.initial += " changed";
            changed = JSON.stringify(v);
          }
          if (name === "permission-revoked") {
            const v = JSON.parse(old);
            v.enabled = false;
            changed = JSON.stringify(v);
          }
          if (name === "execution-tampered") {
            const v = JSON.parse(old);
            v.stderr += " forged";
            changed = JSON.stringify(v);
          }
          await writeFile(path, changed);
          const n = calls;
          await assert.rejects(run());
          assert.equal(calls, n);
          await writeFile(path, old);
        }
        if (name === "database-tampered") {
          const db = new DatabaseSync(join(dir, "orders.sqlite"));
          try {
            db.exec("UPDATE orders SET cents=1 WHERE id='S1'");
            await assert.rejects(run());
          } finally {
            db.exec("UPDATE orders SET cents=120000 WHERE id='S1'");
            db.close();
          }
        }
      }
      if (name === "publication-retry") {
        await run({ stopAfter: "report" });
        await mkdir(join(dir, "output"), { recursive: true });
        await writeFile(join(dir, "output/report.json"), "conflict");
        await assert.rejects(run());
        await rm(join(dir, "output/report.json"));
      }
      result = (await run()) as Report;
    }
    const invalid = [
        "patch-exhausted",
        "unsafe-code",
        "unsafe-sql",
        "wrong-execution",
        "wrong-base",
        "no-change",
      ].includes(name),
      limited = ["deadline", "max-model-calls", "max-executions"].includes(
        name,
      );
    assert.equal(
      result.status,
      invalid || name === "missing-input"
        ? "needs-human"
        : limited
          ? "partial"
          : "completed",
    );
    assert.equal(
      result.stopReason,
      invalid
        ? "patch-attempts-exhausted"
        : name === "missing-input"
          ? "MISSING_INPUT"
          : limited
            ? name
            : "verified",
    );
    assert.ok(result.runs.length >= 1);
    if (name !== "already-correct" && name !== "missing-input")
      assert.equal(result.runs[0]!.status, "failed");
    if (result.status === "completed") {
      assert.equal(result.runs.at(-1)!.status, "passed");
      assert.equal(result.acceptedRevisionId, result.runs.at(-1)!.revisionId);
      assert.ok(
        (await readFile(join(dir, "output", filename(r)), "utf8")).length > 0,
      );
      if (r.kind !== "code")
        assert.deepEqual(
          JSON.parse(await readFile(join(dir, "output/rows.json"), "utf8")),
          [
            { region: "north", totalCents: 160000 },
            { region: "south", totalCents: 80000 },
          ],
        );
    } else assert.equal(result.acceptedRevisionId, null);
    if (
      ["two-rounds", "sql-semantic-repair", "config-semantic-repair"].includes(
        name,
      )
    ) {
      assert.equal(result.runs.length, 3);
      assert.equal(result.runs[1]!.status, "failed");
    }
    if (
      name === "already-correct" ||
      name === "missing-input" ||
      name === "deadline"
    )
      assert.equal(calls, 0);
    if (!children.length) {
      assert.ok(graphs.includes("repair-tool"));
      assert.ok(graphs.includes("repair-memory-write"));
      if (calls) assert.ok(graphs.includes("repair-reasoning"));
    }
    const totalCalls = calls + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.equal(result.usage.modelCalls, totalCalls);
    assert.equal(result.usage.executions, result.runs.length);
    assert.ok(totalCalls <= r.maxModelCalls);
    const before = calls;
    assert.deepEqual(await run(), result);
    assert.equal(calls, before);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8");
    for (const run of result.runs) assert.ok(md.includes(run.id));
    await app!.adapters.verify(result);
    const forged = structuredClone(result);
    forged.status = "completed";
    forged.acceptedRevisionId = result.runs[0]!.revisionId;
    if (name !== "already-correct")
      await assert.rejects(app!.adapters.verify(forged));
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      modelCalls: totalCalls,
      executions: result.runs.length,
      directory: dir,
      graphs: [...new Set(graphs)],
      faultInjection: injected > 0,
      children: children.length,
    };
  } finally {
    await app?.close();
  }
}
const selected = values.only ? values.only.split(",") : cases;
for (const name of selected) assert.ok(cases.includes(name));
let next = 0,
  reporting = Promise.resolve();
async function runner() {
  for (;;) {
    const name = selected[next++];
    if (!name) return;
    try {
      results.push(await runCase(name));
    } catch (e) {
      results.push({
        name,
        status: "failed",
        error: e instanceof Error ? e.stack : String(e),
      });
      console.error(name, e);
    }
    const row = results.at(-1);
    reporting = reporting.then(() =>
      writeFile(
        resolve(values.report!),
        JSON.stringify(
          {
            provider,
            model,
            storage: {
              context: "Redis",
              memory: "SQLite",
              business:
                "SQLite orders, actual Node test/workflow execution, immutable revision files",
            },
            results,
          },
          null,
          2,
        ),
      ),
    );
    await reporting;
    console.log(JSON.stringify(row));
  }
}
await Promise.all([runner(), runner(), runner()]);
await reporting;
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
