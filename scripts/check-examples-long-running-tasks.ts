import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import {
  createDemo,
  type Scenario,
} from "../examples/_shared/tools/long-running/adapters.ts";
import {
  type Report,
  type Checkpoint,
} from "../examples/_shared/tools/long-running/domain.ts";
import {
  runLongTaskLoop,
  scope,
  memoryKey,
  type Options,
} from "../examples/patterns/long-running/index.ts";
import { observedLongTask } from "./fixtures/long-running-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-long-running-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-long-running-tasks" },
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
  "mixed",
  "matched",
  "empty",
  "batch-one",
  "last-short-batch",
  "pause-resume",
  "sample-pause",
  "commit-pause",
  "process-resume",
  "invalid-json-retry",
  "model-failure",
  "review-exhausted",
  "late-review-failure",
  "wrong-batch",
  "duplicate-review",
  "forged-citation",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "business-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "business-row-changed",
  "receipt-changed",
  "checkpoint-missing",
  "checkpoint-ahead",
  "checkpoint-protocol",
  "checkpoint-ahead-of-ledger",
  "transaction-rollback",
  "cancelled",
  "cancel-after-commit",
  "commit-crash",
  "sample-crash",
  "checkpoint-crash",
  "budget-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario: Scenario =
      name === "matched" || name === "empty" ? name : "mixed";
  const r = await createDemo(
      dir,
      {
        batchSize:
          name === "batch-one" ? 1 : name === "last-short-batch" ? 4 : 2,
        maxModelCalls: name === "max-model-calls" ? 1 : 12,
        deadlineSeconds: name === "deadline" ? 1 : 600,
      },
      scenario,
    ),
    input = { request: r, model: { provider: provider!, model: model! } },
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
            name === "cancel-after-commit" &&
            !injected &&
            JSON.stringify(args).includes('"long_commit"')
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
          assert.ok(data.batchId);
          assert.ok(data.items.length <= r.batchSize);
          assert.ok(data.items.every((x: { fact?: string }) => x.fact));
          await writeFile(
            join(dir, `model-${calls}.json`),
            JSON.stringify({ input: args, output: out }, null, 2),
          );
          if (name === "model-failure" && !injected) {
            injected++;
            return {
              status: "failed",
              error: {
                code: "INJECTED_PROVIDER_FAILURE",
                message: "Provider fault for recovery test",
              },
            };
          }
          const changed = structuredClone(out) as {
            output: { message: { content: string } };
          };
          if (
            (name === "invalid-json-retry" && !injected) ||
            name === "review-exhausted" ||
            (name === "late-review-failure" && data.items[0].id === "INV-103")
          ) {
            injected++;
            changed.output.message.content = "invalid review";
            return changed;
          }
          if (
            ["wrong-batch", "duplicate-review", "forged-citation"].includes(
              name,
            )
          ) {
            const p = JSON.parse(
              changed.output.message.content
                .trim()
                .replace(/^```(?:json)?\s*/, "")
                .replace(/\s*```$/, ""),
            );
            if (name === "wrong-batch") p.batchId = "0".repeat(64);
            else if (name === "duplicate-review") p.reviews[1] = p.reviews[0];
            else p.reviews[0].quote = "invented evidence";
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
  let app: Awaited<ReturnType<typeof observedLongTask>> | undefined;
  const open = async () => {
    app = await observedLongTask(dir, r, config, observe);
  };
  const run = (options: Options = {}) =>
    app!.runtime.loop(runLongTaskLoop, [input, options], {
      ...(options.signal ? { signal: options.signal } : {}),
      onGraph: (e) => {
        if (e.status === "started") graphs.push(e.graphId);
      },
    });
  const readCheckpoint = () => {
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      return JSON.parse(
        String(
          db
            .prepare("SELECT content FROM memories WHERE memory_key=?")
            .get(memoryKey(r, "checkpoint"))!.content,
        ),
      ).value as Checkpoint;
    } finally {
      db.close();
    }
  };
  async function child(phase: string) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/long-running-child.ts",
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
      assert.equal(result.signal, "SIGKILL", result.stderr);
    else assert.equal(result.code, 0, result.stderr);
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  try {
    let result: Report;
    if (name.endsWith("-crash") || name === "process-resume") {
      await child(name === "process-resume" ? "pause" : name);
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
      if (name === "cancel-after-commit")
        await assert.rejects(run({ signal: controller.signal }));
      if (name === "sample-pause" || name === "commit-pause") {
        const stopped = await run({
          stopAfter: name === "sample-pause" ? "sample" : "commit",
        });
        assert.equal(stopped.status, "paused");
        assert.equal(readCheckpoint().cursor, 0);
        await app!.close();
        await open();
      }
      if (name === "pause-resume") {
        for (const cursor of [2, 4]) {
          const p = await run({ pauseAfterBatches: 1 });
          assert.equal(p.status, "paused");
          assert.equal(p.cursor, cursor);
          assert.equal(readCheckpoint().cursor, cursor);
          await app!.close();
          await open();
        }
      }
      if (name === "deadline") {
        await run({ stopAfter: "sample" });
        await delay(1100);
      }
      if (
        [
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "business-unavailable",
          "request-changed",
          "source-changed",
          "permission-revoked",
          "business-row-changed",
          "receipt-changed",
          "checkpoint-missing",
          "checkpoint-ahead",
          "checkpoint-protocol",
          "checkpoint-ahead-of-ledger",
        ].includes(name)
      ) {
        await run({ pauseAfterBatches: 1 });
        assert.equal(readCheckpoint().cursor, 2);
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
          const before = calls;
          await assert.rejects(run());
          assert.equal(calls, before);
          await app!.close();
          await open();
        }
        if (name === "memory-unavailable" || name === "business-unavailable") {
          const db = new DatabaseSync(
              join(
                dir,
                name === "memory-unavailable"
                  ? "memory.sqlite"
                  : "reviews.sqlite",
              ),
            ),
            table = name === "memory-unavailable" ? "memories" : "receipts";
          try {
            db.exec(`ALTER TABLE ${table} RENAME TO unavailable`);
            const before = calls;
            await assert.rejects(run());
            assert.equal(calls, before);
          } finally {
            db.exec(`ALTER TABLE unavailable RENAME TO ${table}`);
            db.close();
          }
        }
        if (
          ["request-changed", "source-changed", "permission-revoked"].includes(
            name,
          )
        ) {
          const path = join(
              dir,
              name === "request-changed"
                ? "request.json"
                : name === "source-changed"
                  ? "invoices.json"
                  : "policy.json",
            ),
            old = await readFile(path, "utf8"),
            v = JSON.parse(old);
          if (name === "request-changed") v.goal += " changed";
          else if (name === "source-changed") v[0].invoiceCents++;
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          const before = calls;
          await assert.rejects(run());
          assert.equal(calls, before);
          await writeFile(path, old);
        }
        if (["business-row-changed", "receipt-changed"].includes(name)) {
          const db = new DatabaseSync(join(dir, "reviews.sqlite")),
            table = name === "business-row-changed" ? "reviews" : "receipts",
            row = db.prepare(`SELECT rowid,body FROM ${table} LIMIT 1`).get()!,
            v = JSON.parse(String(row.body));
          if (name === "business-row-changed") v.summary += " tampered";
          else v.id = "0".repeat(64);
          try {
            db.prepare(`UPDATE ${table} SET body=? WHERE rowid=?`).run(
              JSON.stringify(v),
              Number(row.rowid),
            );
            const before = calls;
            await assert.rejects(run());
            assert.equal(calls, before);
          } finally {
            db.prepare(`UPDATE ${table} SET body=? WHERE rowid=?`).run(
              String(row.body),
              Number(row.rowid),
            );
            db.close();
          }
        }
        if (
          [
            "checkpoint-missing",
            "checkpoint-ahead",
            "checkpoint-protocol",
          ].includes(name)
        ) {
          const db = new DatabaseSync(join(dir, "memory.sqlite")),
            row = db
              .prepare("SELECT * FROM memories WHERE memory_key=?")
              .get(memoryKey(r, "checkpoint"))!,
            v = JSON.parse(String(row.content));
          try {
            if (name === "checkpoint-missing")
              db.prepare("DELETE FROM memories WHERE id=?").run(String(row.id));
            else {
              if (name === "checkpoint-ahead") v.value.cursor = 4;
              else v.value.protocol = 99;
              db.prepare("UPDATE memories SET content=? WHERE id=?").run(
                JSON.stringify(v),
                String(row.id),
              );
            }
            const before = calls;
            await assert.rejects(run());
            assert.equal(calls, before);
          } finally {
            if (name === "checkpoint-missing")
              db.prepare(
                "INSERT INTO memories(id,memory_key,content,metadata) VALUES(?,?,?,?)",
              ).run(
                String(row.id),
                String(row.memory_key),
                String(row.content),
                row.metadata === null ? null : String(row.metadata),
              );
            else
              db.prepare("UPDATE memories SET content=? WHERE id=?").run(
                String(row.content),
                String(row.id),
              );
            db.close();
          }
        }
        if (name === "checkpoint-ahead-of-ledger") {
          const db = new DatabaseSync(join(dir, "reviews.sqlite")),
            receipts = db.prepare("SELECT * FROM receipts").all(),
            reviews = db.prepare("SELECT * FROM reviews").all(),
            audit = db.prepare("SELECT * FROM audit").all();
          try {
            db.exec(
              "DELETE FROM receipts; DELETE FROM reviews; DELETE FROM audit",
            );
            await assert.rejects(run());
          } finally {
            for (const x of receipts)
              db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
                String(x.batch_id),
                Number(x.start_index),
                String(x.body),
              );
            for (const x of reviews)
              db.prepare("INSERT INTO reviews VALUES(?,?,?)").run(
                String(x.invoice_id),
                String(x.batch_id),
                String(x.body),
              );
            for (const x of audit)
              db.prepare("INSERT INTO audit VALUES(?,?)").run(
                String(x.batch_id),
                String(x.receipt_id),
              );
            db.close();
          }
        }
      }
      if (name === "transaction-rollback") {
        const db = new DatabaseSync(join(dir, "reviews.sqlite"));
        try {
          db.exec(
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
          );
          await assert.rejects(run());
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM reviews").get()!.n,
            0,
          );
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM audit").get()!.n,
            0,
          );
          assert.equal(readCheckpoint().cursor, 0);
        } finally {
          db.exec("DROP TRIGGER fail_receipt");
          db.close();
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
    const rejected = [
        "review-exhausted",
        "wrong-batch",
        "duplicate-review",
        "forged-citation",
        "late-review-failure",
      ].includes(name),
      limited = ["max-model-calls", "deadline"].includes(name);
    assert.equal(
      result.status,
      rejected ? "needs-human" : limited ? "partial" : "completed",
    );
    assert.equal(
      result.stopReason,
      rejected ? "review-attempts-exhausted" : limited ? name : "completed",
    );
    assert.equal(
      result.cursor,
      name === "empty" ||
        name === "deadline" ||
        (rejected && name !== "late-review-failure")
        ? 0
        : name === "late-review-failure" || name === "max-model-calls"
          ? 2
          : 6,
    );
    const totalCalls = calls + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.equal(
      result.usage.modelCalls,
      totalCalls + (name === "budget-crash" ? 1 : 0),
    );
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    if (name === "empty") assert.equal(totalCalls, 0);
    if (["commit-crash", "commit-pause", "cancel-after-commit"].includes(name))
      assert.equal(result.recoveredCommits, 1);
    else assert.equal(result.recoveredCommits, 0);
    const db = new DatabaseSync(join(dir, "reviews.sqlite"));
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM reviews").get()!.n,
        result.cursor,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM audit").get()!.n,
        result.receipts.length,
      );
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM receipts").get()!.n,
        result.receipts.length,
      );
    } finally {
      db.close();
    }
    assert.equal(readCheckpoint().cursor, result.cursor);
    assert.equal(readCheckpoint().status, result.status);
    const before = calls;
    assert.deepEqual(await run(), result);
    assert.equal(calls, before);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const csv = await readFile(join(dir, "output/reviews.csv"), "utf8");
    assert.equal(csv.trim().split("\n").length, result.cursor + 1);
    await app!.adapters.verify(result);
    if (result.status !== "completed")
      await assert.rejects(
        app!.adapters.verify({ ...result, status: "completed" }),
      );
    if (!children.length) {
      assert.ok(graphs.includes("long-task-tool"));
      assert.ok(graphs.includes("long-task-memory-write"));
      if (calls) assert.ok(graphs.includes("long-task-reasoning"));
    }
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      cursor: result.cursor,
      modelCalls: totalCalls,
      reservedCalls: result.usage.modelCalls,
      recoveredCommits: result.recoveredCommits,
      batches: result.receipts.length,
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
                "transactional SQLite review rows, receipts and audit; CSV/Markdown report",
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
