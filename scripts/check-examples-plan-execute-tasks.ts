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
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import {
  createDemo,
  type Scenario,
} from "../examples/_shared/tools/plan-execute/adapters.ts";
import type { Report } from "../examples/_shared/tools/plan-execute/domain.ts";
import {
  runPlanExecute,
  runPlanExecuteLoop,
  scope,
  type Options,
} from "../examples/patterns/plan-and-execute/index.ts";
import { observedPlanExecute } from "./fixtures/plan-execute-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-plan-execute-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-plan-execute-tasks" },
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
  "stable",
  "price-change",
  "unavailable",
  "no-stock",
  "lost-response",
  "economy-preference",
  "max-plans",
  "max-actions",
  "deadline",
  "invalid-tool",
  "invalid-dependency",
  "incomplete-plan",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "permission-revoked",
  "evidence-tampered",
  "cancelled",
  "cancel-after-effect",
  "effect-crash",
  "plan-1-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario: Scenario = [
      "stable",
      "price-change",
      "unavailable",
      "no-stock",
      "lost-response",
    ].includes(name)
      ? (name as Scenario)
      : name === "max-plans"
        ? "price-change"
        : "stable";
  const r = await createDemo(dir, scenario, {
    maxPlans: name === "max-plans" ? 1 : 3,
    maxActions: name === "max-actions" ? 0 : 12,
    deadlineSeconds: name === "deadline" ? 1 : 600,
    ...(name === "economy-preference"
      ? {
          goal: "Fulfill this order using economy shipping, then verify the receipt.",
        }
      : {}),
  });
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  const controller = new AbortController();
  let injected = 0;
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const out = await w.execute(node, input, context);
          if (
            name === "cancel-after-effect" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"ship_standard"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((s) => s === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            if (
              [
                "invalid-tool",
                "invalid-dependency",
                "incomplete-plan",
              ].includes(name)
            ) {
              const changed = structuredClone(out) as {
                output: { message: { content: string } };
              };
              const p = JSON.parse(
                changed.output.message.content
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (name === "invalid-tool") p.steps[0].tool = "delete_database";
              if (name === "invalid-dependency")
                p.steps[0].dependsOn = [p.steps.at(-1).id];
              if (name === "incomplete-plan") p.steps.pop();
              changed.output.message.content = JSON.stringify(p);
              injected++;
              return changed;
            }
          }
          return out;
        },
        async dispose() {
          await w.dispose?.();
        },
      };
    },
  });
  let app: Awaited<ReturnType<typeof observedPlanExecute>> | undefined;
  const open = async () =>
    (app = await observedPlanExecute(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(
      runPlanExecuteLoop,
      [{ request: r, model: { provider: provider!, model: model! } }, options],
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onGraph: (e) => {
          if (e.status === "started") graphs.push(e.graphId);
        },
      },
    );
  async function child(phase: string) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/plan-execute-child.ts",
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
      p.on("exit", (code, signal) => resolve({ code, signal, stderr }));
    });
    if (phase.endsWith("-crash"))
      assert.equal(result.signal, "SIGKILL", result.stderr);
    else assert.equal(result.code, 0, result.stderr);
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  let result: Report;
  try {
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
      if (name === "cancel-after-effect")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "request-changed",
          "permission-revoked",
          "deadline",
        ].includes(name)
      ) {
        await run({ stopAfter: "plan" });
        if (name === "redis-expiry") {
          const key =
            (config.context.cache?.keyPrefix ?? "ditto:context:") +
            contextScopeKey(scope(r));
          assert.ok(await app!.storage.redis.get(key));
          await app!.storage.redis.pExpire(key, 1);
          await delay(10);
          assert.equal(await app!.storage.redis.get(key), null);
        }
        if (name === "redis-unavailable") {
          await app!.storage.redis.quit();
          await assert.rejects(run());
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
        if (["request-changed", "permission-revoked"].includes(name)) {
          const path = join(
              dir,
              name === "request-changed" ? "request.json" : "policy.json",
            ),
            saved = await readFile(path, "utf8"),
            v = JSON.parse(saved);
          if (name === "request-changed") v.quantity++;
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await writeFile(path, saved);
        }
        if (name === "deadline") await delay(1100);
      }
      if (name === "evidence-tampered") {
        await run({ stopAfter: "step" });
        const path = join(
            dir,
            "evidence",
            (await readdir(join(dir, "evidence")))[0]!,
          ),
          saved = await readFile(path, "utf8");
        await writeFile(path, saved.replace('"quantity":2', '"quantity":3'));
        await assert.rejects(run());
        await writeFile(path, saved);
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
    assert.notEqual(result.status, "checkpoint");
    const state = app!.adapters.snapshot(),
      db = app!.adapters.db,
      ops = Number(db.prepare("SELECT COUNT(*) AS n FROM operations").get()!.n);
    if (
      [
        "max-plans",
        "max-actions",
        "deadline",
        "invalid-tool",
        "invalid-dependency",
        "incomplete-plan",
      ].includes(name)
    ) {
      assert.equal(result.status, "partial");
      assert.equal(
        result.stopReason,
        name.startsWith("invalid") || name === "incomplete-plan"
          ? "invalid-plan"
          : name,
      );
      assert.equal(result.receipt, null);
    } else if (["unavailable", "no-stock"].includes(name)) {
      assert.equal(result.status, "needs-human");
      assert.equal(state.state, name === "no-stock" ? "new" : "packed");
      assert.equal(result.receipt, null);
    } else {
      assert.equal(result.status, "completed");
      assert.equal(state.state, "shipped");
      assert.equal(state.stock, 8);
      assert.equal(ops, 4);
      assert.equal(
        result.receipt?.cost,
        ["price-change", "economy-preference"].includes(name) ? 400 : 300,
      );
      const receipt = JSON.parse(
        await readFile(join(dir, "shipment.json"), "utf8"),
      );
      assert.equal(receipt.tracking, result.receipt?.tracking);
      assert.equal(receipt.quantity, 2);
    }
    if (name === "price-change") {
      assert.equal(result.plans.length, 2);
      assert.deepEqual(
        result.plans[1]!.plan.steps.map((s) => s.tool),
        ["ship_economy", "read_receipt"],
      );
      assert.equal(result.changes[0]!.code, "ENVIRONMENT_CHANGED");
      assert.equal(
        result.completed.filter((c) => c.step.tool === "reserve_stock").length,
        1,
      );
    }
    if (name === "lost-response") {
      assert.equal(result.plans.length, 2);
      assert.deepEqual(
        result.plans[1]!.plan.steps.map((s) => s.tool),
        ["read_receipt"],
      );
      assert.equal(result.changes[0]!.code, "OUTCOME_UNKNOWN");
    }
    if (name.startsWith("invalid") || name === "incomplete-plan") {
      assert.equal(injected, 1);
      assert.equal(ops, 0);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    const replay = await runPlanExecute(app!.runtime, {
      request: r,
      model: { provider: provider!, model: model! },
    });
    assert.deepEqual(replay, result);
    assert.equal(
      spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
      before,
    );
    const calls = before + children.reduce((s, c) => s + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxPlans);
    assert.ok(result.usage.actionCalls <= r.maxActions);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      modelCalls: calls,
      plans: result.plans.length,
      operations: ops,
      graphs: [...new Set(graphs)],
      directory: dir,
      faultInjection: injected > 0,
      children: children.length,
    };
  } finally {
    await app?.close();
  }
}
for (const name of values.only ? values.only.split(",") : cases) {
  assert.ok(cases.includes(name));
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
  await writeFile(
    resolve(values.report!),
    JSON.stringify(
      {
        provider,
        model,
        storage: {
          context: "Redis",
          memory: "SQLite",
          business: "separate SQLite",
        },
        realModel: true,
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results.at(-1)));
}
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
