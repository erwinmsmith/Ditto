import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { dataCodeTools } from "../examples/_shared/tools/data-and-code/tools.ts";
import { createFixture } from "../examples/_shared/tools/data-and-code/fixtures.ts";
import {
  modes,
  digest,
  isCode,
  type Mode,
  type Material,
} from "../examples/_shared/tools/data-and-code/domain.ts";
import {
  sandbox,
  model,
  toolConfig,
} from "../examples/capabilities/data-and-code/cli.ts";
import {
  runDataCode,
  scope,
  memoryKey,
  type Report,
  type Options,
} from "../examples/capabilities/data-and-code/shared.ts";
const { values } = parseArgs({
  options: {
    report: {
      type: "string",
      default: ".examples-data-code-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-data-code-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  selected = model(config),
  tc = toolConfig();
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
let reportWrites = Promise.resolve();
const cases = [
  ...modes.map((mode) => ({ name: mode + "-complete", mode })),
  ...modes.map((mode) => ({ name: mode + "-cache-expiry", mode })),
  ...[
    "redis-unavailable",
    "memory-unavailable",
    "source-missing",
    "source-changed",
    "source-symlink",
    "snapshot-resume",
    "input-changed",
    "wrong-evidence",
    "publication-retry",
    "cancel-before-work",
    "material-crash",
    "plan-crash",
    "outcome-crash",
    "execute-effect-crash",
    "publish-effect-crash",
    "sql-write-denied",
  ].map((name) => ({ name, mode: "query" as Mode })),
  { name: "code-test-failure", mode: "code-modification" as Mode },
  { name: "protected-test-target", mode: "code-modification" as Mode },
  { name: "code-timeout", mode: "calculation" as Mode },
  { name: "artifact-tampered", mode: "visualization" as Mode },
];
limitCapabilityCases(cases);
async function runCase(item: (typeof cases)[number]) {
  console.log(JSON.stringify({ name: item.name, event: "started" }));
  const dir = join(directory, item.name),
    r = await createFixture(dir, item.mode),
    spans: string[] = [],
    children: { modelCalls: number }[] = [];
  let fault = "";
  function observed(d: WorkerDefinition): WorkerDefinition {
    return {
      ...d,
      instantiate() {
        const w = d.instantiate();
        return {
          async execute(node, input, context) {
            spans.push(node);
            let actual = input;
            if (fault && node === "INTERACTION.ACT.TOOL") {
              const cloned = structuredClone(input) as {
                call: {
                  name: string;
                  arguments: { plan?: { arguments: Record<string, unknown> } };
                };
              };
              if (cloned.call.arguments.plan) {
                const a = cloned.call.arguments.plan.arguments;
                if (fault === "sql") a.sql = "DELETE FROM sales";
                if (fault === "code")
                  a.content =
                    "export function invoiceTotal(items) { return 0; }";
                if (fault === "target") a.path = "invoice.test.mjs";
                if (fault === "timeout") a.code = "while (true) {}";
                actual = cloned;
              }
            }
            const result = await w.execute(node, actual, context);
            if (node === "INFER.REASONING.SAMPLE") {
              await writeFile(
                join(
                  dir,
                  `model-response-${spans.filter((n) => n === node).length}.json`,
                ),
                JSON.stringify(result, null, 2),
              );
              if (fault === "evidence") {
                const changed = structuredClone(result) as {
                  output: { message: { content: string } };
                };
                const text = changed.output.message.content;
                const a = JSON.parse(
                  text
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                if (a.insights) {
                  a.insights[0].evidence[0].pointer = "/nonexistent";
                  changed.output.message.content = JSON.stringify(a);
                  return changed;
                }
              }
            }
            return result;
          },
          async dispose() {
            await w.dispose?.();
          },
        };
      },
    };
  }
  let storage = await openAgentStorage(dir, config);
  const open = () =>
    createDitto({
      config,
      sandbox: sandbox(config, r),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: dataCodeTools(dir, r, tc) }),
      ].map(observed),
    });
  let runtime = open();
  const entry = await import(`../examples/capabilities/data-and-code/${r.mode}.ts`) as { run: typeof runDataCode };
  const run = (options: Options = {}) =>
      entry.run(runtime, { request: r, model: selected }, options),
    calls = () =>
      spans.filter((n) => n === "INFER.REASONING.SAMPLE").length +
      children.reduce((n, c) => n + c.modelCalls, 0);
  const reopen = async () => {
    await runtime.close();
    await storage.close();
    storage = await openAgentStorage(dir, config);
    runtime = open();
  };
  async function expire() {
    const key =
      (config.context.cache?.keyPrefix ?? "ditto:context:") +
      contextScopeKey(scope(r));
    await storage.redis.pExpire(key, 1);
    await delay(20);
    assert.equal(await storage.redis.get(key), null);
  }
  async function saved(stage: string) {
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      const row = db
        .prepare("SELECT content FROM memories WHERE memory_key=?")
        .get(memoryKey(r, stage)) as { content: string };
      return JSON.parse(row.content).value;
    } finally {
      db.close();
    }
  }
  async function absent() {
    assert.equal(
      await readFile(join(dir, "output/report.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  }
  async function child(phase: string) {
    await new Promise<void>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/data-code-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      p.stderr.on("data", (v) => (err += String(v)));
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(err || "Expected SIGKILL"))
          : code === 0
            ? done()
            : reject(new Error(err)),
      );
    });
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  const record: Record<string, unknown> = {
    name: item.name,
    mode: item.mode,
    status: "failed",
    directory: dir,
  };
  try {
    if (item.name.endsWith("cache-expiry")) {
      await run({ stopAfter: "outcome" });
      await expire();
      await reopen();
    }
    switch (item.name) {
      case "redis-unavailable":
        await storage.redis.quit();
        await assert.rejects(run());
        assert.equal(calls(), 0);
        await reopen();
        break;
      case "memory-unavailable": {
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          db.exec("ALTER TABLE memories RENAME TO missing_memories");
          await assert.rejects(run());
          assert.equal(calls(), 0);
          db.exec("ALTER TABLE missing_memories RENAME TO memories");
        } finally {
          db.close();
        }
        await reopen();
        break;
      }
      case "source-missing":
      case "source-changed":
      case "source-symlink": {
        const p = join(dir, r.sources[0]!.path),
          original = await readFile(p);
        await rm(p);
        if (item.name === "source-changed") await writeFile(p, "changed");
        if (item.name === "source-symlink") await symlink("/etc/hosts", p);
        await assert.rejects(run());
        await absent();
        assert.equal(calls(), 0);
        await rm(p, { force: true });
        await writeFile(p, original);
        break;
      }
      case "snapshot-resume":
        await run({ stopAfter: "material" });
        await writeFile(
          join(dir, r.sources[0]!.path),
          "changed after snapshot",
        );
        await expire();
        await reopen();
        break;
      case "input-changed":
        await run({ stopAfter: "material" });
        await assert.rejects(
          runDataCode(runtime, {
            request: { ...r, instruction: "Changed task" },
            model: selected,
          }),
          /Request changed/,
        );
        break;
      case "wrong-evidence":
        fault = "evidence";
        await assert.rejects(run(), /pointer/);
        await absent();
        fault = "";
        break;
      case "publication-retry":
        await mkdir(join(dir, "output"));
        await writeFile(join(dir, "output/report.md"), "conflicting report");
        await assert.rejects(run());
        await rm(join(dir, "output/report.md"));
        await reopen();
        break;
      case "cancel-before-work":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        await absent();
        break;
      case "material-crash":
      case "plan-crash":
      case "outcome-crash":
      case "execute-effect-crash":
      case "publish-effect-crash":
        await child(item.name);
        await expire();
        await child("continue");
        break;
      case "sql-write-denied":
        fault = "sql";
        await assert.rejects(run(), /not authorized/);
        await absent();
        assert.equal(
          digest(await readFile(join(dir, "snapshots/business.sqlite"))),
          r.sources.find((s) => s.path === "business.sqlite")!.sha256,
        );
        fault = "";
        break;
      case "code-test-failure":
        fault = "code";
        await assert.rejects(run(), /protected tests/);
        await absent();
        fault = "";
        break;
      case "protected-test-target":
        fault = "target";
        await assert.rejects(run(), /Patch target/);
        await absent();
        fault = "";
        break;
      case "code-timeout":
        fault = "timeout";
        await assert.rejects(run(), /timed out/);
        await absent();
        fault = "";
        break;
      case "artifact-tampered": {
        await run({ stopAfter: "outcome" });
        const path = join(dir, "output/chart.png"),
          bytes = await readFile(path);
        await writeFile(path, "changed");
        await assert.rejects(run(), /checksum/);
        await absent();
        await writeFile(path, bytes);
        break;
      }
    }
    const report = (await run()) as Report,
      expected = JSON.parse(await readFile(join(dir, "expected.json"), "utf8")),
      o = report.outcome.result as Record<string, unknown>,
      m = (await saved("material")) as Material;
    assert.equal(report.mode, r.mode);
    if (r.mode === "query") assert.deepEqual(o.rows, expected.metrics.byRegion);
    if (r.mode === "cleaning") {
      assert.deepEqual(o.rows, expected.rows);
      assert.equal((o.issues as unknown[]).length, expected.removedRows);
      const csv = await readFile(join(dir, "output/cleaned.csv"), "utf8");
      assert.equal(csv.trim().split("\n").length, 7);
    }
    if (r.mode === "calculation" || r.mode === "interpretation")
      assert.deepEqual(o, expected.metrics);
    if (r.mode === "exploration") {
      assert.equal(o.rawRows, 12);
      assert.equal(o.cleanRows, 6);
      assert.deepEqual(o.statusCounts, { paid: 4, pending: 1, refunded: 1 });
      assert.ok(typeof o.pearsonQuantityLineValue === "number");
      const cols = o.columns as { name: string; missing: number }[];
      assert.equal(cols.find((c) => c.name === "region")?.missing, 1);
      assert.equal(cols.find((c) => c.name === "quantity")?.missing, 1);
    }
    if (r.mode === "visualization") {
      const series = o.series as {
        region: string;
        status: string;
        revenueCents: number;
      }[];
      for (const p of series) {
        const sum = expected.rows
          .filter(
            (r: { region: string; status: string }) =>
              r.region === p.region && r.status === p.status,
          )
          .reduce(
            (s: number, r: { quantity: number; unitCents: number }) =>
              s + r.quantity * r.unitCents,
            0,
          );
        assert.equal(p.revenueCents, sum);
      }
      const png = await readFile(join(dir, "output/chart.png"));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      const svg = await readFile(join(dir, "output/chart.svg"), "utf8");
      for (const label of [
        "East",
        "North",
        "West",
        "Unknown",
        "paid",
        "pending",
        "refunded",
        "USD",
      ])
        assert.ok(svg.includes(label));
    }
    if (r.mode === "code-search") {
      const matches = o.matches as {
        path: string;
        line: number;
        text: string;
      }[];
      assert.ok(matches.some((m) => m.path === "invoice.mjs"));
      for (const hit of matches)
        assert.equal(
          m.files.find((f) => f.path === hit.path)!.content!.split("\n")[
            hit.line - 1
          ],
          hit.text,
        );
    }
    if (
      ["code-generation", "code-modification", "execution"].includes(r.mode)
    ) {
      const before = o.before as { exitCode: number },
        after = o.after as { exitCode: number; stdout: string };
      assert.notEqual(before.exitCode, 0);
      assert.equal(after.exitCode, 0);
      assert.match(after.stdout, /# pass 7/);
      assert.equal(
        o.protectedTestSha256,
        r.sources.find((s) => s.path === "invoice.test.mjs")!.sha256,
      );
      assert.notEqual(o.beforeSha256, o.afterSha256);
      assert.match(
        await readFile(join(dir, "output/invoice.mjs"), "utf8"),
        /export/,
      );
    }
    if (r.mode === "diagnosis" || r.mode === "code-review") {
      assert.notEqual((o.tests as { exitCode: number }).exitCode, 0);
      assert.ok(
        report.interpretation.issues.some(
          (i) => i.path === "invoice.mjs" && i.line === 4,
        ),
      );
      assert.match(JSON.stringify(report.interpretation.issues), /quantit/i);
    }
    for (const f of report.delivery.files) {
      const b = await readFile(join(dir, f.file));
      assert.equal(digest(b), f.sha256);
      assert.equal(b.length, f.bytes);
    }
    for (const s of r.sources)
      assert.equal(
        digest(await readFile(join(dir, "snapshots", s.path))),
        s.sha256,
      );
    if (isCode(r.mode))
      assert.equal(
        digest(await readFile(join(dir, "invoice.test.mjs"))),
        r.sources.find((s) => s.path === "invoice.test.mjs")!.sha256,
      );
    const before = calls();
    assert.deepEqual(await run(), report);
    assert.equal(calls(), before);
    assert.equal(calls(), item.name === "wrong-evidence" ? 3 : 2);
    Object.assign(record, {
      status: "passed",
      modelCalls: calls(),
      artifacts: report.delivery.files,
      tool: report.outcome.tool,
    });
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    record.modelCalls = calls();
    results.push(record);
    await runtime.close();
    await storage.close();
    reportWrites = reportWrites.then(() =>
      writeFile(
        resolve(values.report!),
        JSON.stringify(
          {
            startedAt,
            directory,
            model: selected,
            storage: {
              context: "Redis",
              memory: "file SQLite",
              business: "separate SQLite",
            },
            results,
            passed: results.filter((r) => r.status === "passed").length,
            total: cases.length,
            modelCalls: results.reduce(
              (n, r) => n + Number(r.modelCalls ?? 0),
              0,
            ),
          },
          null,
          2,
        ),
      ),
    );
    await reportWrites;
    console.log(JSON.stringify(record));
  }
}
const queue = [...cases],
  errors: unknown[] = [];
async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    try {
      await runCase(item);
    } catch (e) {
      errors.push(e);
    }
  }
}
await Promise.all([worker(), worker()]);
if (errors.length)
  throw new AggregateError(errors, "Data/code experiments failed");
console.log(`Passed ${results.length} task experiments.`);
