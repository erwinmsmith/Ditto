import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  access,
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
} from "../examples/_shared/tools/tool-chain/service.ts";
import { createTask } from "../examples/_shared/tools/tool-chain/adapters.ts";
import type { Report } from "../examples/_shared/tools/tool-chain/domain.ts";
import {
  runToolChain,
  runToolChainLoop,
  scope,
  type Options,
} from "../examples/patterns/tool-chain/index.ts";
import { observedToolChain } from "./fixtures/tool-chain-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-tool-chain-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-tool-chain-tasks" },
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
  "serial",
  "parallel",
  "conditional-healthy",
  "conditional-exception",
  "serial-healthy",
  "stale",
  "racing-read",
  "crm-disconnect",
  "notify-disconnect",
  "notify-fails",
  "payment-fails",
  "change-after-crm",
  "no-write",
  "no-notify",
  "invalid-analysis",
  "wrong-identity",
  "max-effects-zero",
  "max-effects-one",
  "max-model-calls",
  "max-rounds",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "permission-revoked",
  "evidence-tampered",
  "cancelled",
  "cancel-after-crm",
  "effect-crash",
  "notification-crash",
  "analysis-1-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario: Scenario = [
      "stale",
      "racing-read",
      "crm-disconnect",
      "notify-disconnect",
      "notify-fails",
      "payment-fails",
      "change-after-crm",
    ].includes(name)
      ? (name as Scenario)
      : ["max-model-calls", "max-rounds"].includes(name)
        ? "stale"
        : name.endsWith("healthy")
          ? "healthy"
          : "exception";
  const demo = await createDemo(dir, scenario, {
    mode: name.startsWith("serial")
      ? "serial"
      : name === "parallel"
        ? "parallel"
        : "conditional",
    allowCrmWrite: name !== "no-write",
    allowNotify: name !== "no-notify",
    maxEffects:
      name === "max-effects-zero" ? 0 : name === "max-effects-one" ? 1 : 6,
    maxModelCalls: name === "max-model-calls" ? 1 : 3,
    maxRounds: name === "max-rounds" ? 1 : 3,
    deadlineSeconds: name === "deadline" ? 1 : 600,
  });
  const r = await createTask(dir, demo.request),
    db = demo.service.db,
    spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    controller = new AbortController();
  let injected = 0;
  const count = (table: string) =>
    Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const out = await w.execute(node, input, context);
          if (
            name === "cancel-after-crm" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"chain_crm"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((n) => n === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            if (["invalid-analysis", "wrong-identity"].includes(name)) {
              const changed = structuredClone(out) as {
                output: { message: { content: string } };
              };
              if (name === "invalid-analysis")
                changed.output.message.content = "not JSON";
              else {
                const value = JSON.parse(
                  changed.output.message.content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                value.customerId = "OTHER";
                changed.output.message.content = JSON.stringify(value);
              }
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
  let app: Awaited<ReturnType<typeof observedToolChain>> | undefined;
  const open = async () =>
    (app = await observedToolChain(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(
      runToolChainLoop,
      [{ request: r, model: { provider: provider!, model: model! } }, options],
      {
        concurrency: 4,
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
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/tool-chain-child.ts",
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
        assert.equal(count("requests"), 0);
      }
      if (name === "cancel-after-crm")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "request-changed",
          "permission-revoked",
          "deadline",
          "evidence-tampered",
        ].includes(name)
      ) {
        await run({ stopAfter: "reads" });
        if (name === "redis-expiry") {
          // Populate a working context, then expire the actual Redis key.
          await run({ stopAfter: "analysis" });
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
          const m = new DatabaseSync(join(dir, "memory.sqlite"));
          try {
            m.exec("ALTER TABLE memories RENAME TO unavailable");
            await assert.rejects(run());
          } finally {
            m.exec("ALTER TABLE unavailable RENAME TO memories");
            m.close();
          }
        }
        if (["request-changed", "permission-revoked"].includes(name)) {
          const path = join(
              dir,
              name === "request-changed" ? "request.json" : "policy.json",
            ),
            saved = await readFile(path, "utf8"),
            v = JSON.parse(saved);
          if (name === "request-changed") v.goal += " changed";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await writeFile(path, saved);
        }
        if (name === "evidence-tampered") {
          const path = join(
              dir,
              "evidence",
              (await readdir(join(dir, "evidence")))[0]!,
            ),
            saved = await readFile(path, "utf8");
          await writeFile(path, saved + " ");
          await assert.rejects(run());
          assert.equal(count("crm"), 0);
          assert.equal(count("inbox"), 0);
          assert.equal(
            spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
            0,
          );
          await writeFile(path, saved);
        }
        if (name === "deadline") await delay(1100);
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
    const reasons: Record<string, string> = {
      "notify-fails": "notification-failed",
      "payment-fails": "read-failed",
      "change-after-crm": "state-changed-after-crm",
      "no-write": "permission-required",
      "no-notify": "permission-required",
      "invalid-analysis": "invalid-analysis",
      "wrong-identity": "invalid-analysis",
      "max-effects-zero": "max-effects",
      "max-effects-one": "max-effects",
      "max-model-calls": "max-model-calls",
      "max-rounds": "max-rounds",
      deadline: "deadline",
    };
    assert.equal(
      result.status,
      ["no-write", "no-notify"].includes(name)
        ? "needs-human"
        : reasons[name]
          ? "partial"
          : "completed",
    );
    assert.equal(
      result.stopReason,
      reasons[name] ??
        (name === "conditional-healthy" ? "no-action-required" : "completed"),
    );
    const crmExpected =
      (result.status === "completed" && name !== "conditional-healthy") ||
      ["notify-fails", "change-after-crm", "max-effects-one"].includes(name);
    const notifyExpected =
      result.status === "completed" && name !== "conditional-healthy";
    assert.equal(count("crm"), crmExpected ? 1 : 0);
    assert.equal(count("inbox"), notifyExpected ? 1 : 0);
    assert.equal(
      count("operations"),
      Number(crmExpected) + Number(notifyExpected),
    );
    assert.equal(!!result.crm, crmExpected);
    assert.equal(!!result.notification, notifyExpected);
    if (crmExpected) {
      const row = db.prepare("SELECT * FROM crm").get()!;
      assert.equal(row.updates, 1);
      assert.equal(row.status, result.crm!.payload.status);
      assert.equal(row.revision, result.crm!.payload.revision);
      assert.equal(row.message, result.crm!.payload.message);
    }
    if (notifyExpected) {
      const row = db.prepare("SELECT * FROM inbox").get()!;
      assert.equal(row.recipient, r.recipient);
      assert.equal(row.message, result.notification!.payload.message);
      assert.deepEqual(
        JSON.parse(
          await readFile(join(dir, "output/notification.json"), "utf8"),
        ),
        result.notification,
      );
    } else await assert.rejects(access(join(dir, "output/notification.json")));
    if (
      [
        "crm-disconnect",
        "notify-disconnect",
        "effect-crash",
        "notification-crash",
        "cancel-after-crm",
      ].includes(name)
    ) {
      for (const kind of ["crm", "notify"])
        assert.equal(
          db
            .prepare("SELECT count(*) AS n FROM requests WHERE path=?")
            .get(`/${kind}`)!.n,
          1,
        );
    }
    if (name === "notify-fails")
      assert.equal(
        db
          .prepare("SELECT count(*) AS n FROM requests WHERE path='/notify'")
          .get()!.n,
        2,
      );
    if (["stale", "racing-read"].includes(name)) {
      assert.equal(result.rounds.length, 2);
      assert.equal(result.crm!.payload.revision, 2);
      assert.equal(result.usage.modelCalls, name === "stale" ? 2 : 1);
    }
    if (name === "payment-fails") {
      assert.equal(result.usage.modelCalls, 0);
      assert.equal(
        (result.rounds[0]!.reads as Record<string, { status: string }>)
          .shipment!.status,
        "success",
      );
    }
    if (["serial", "parallel", "conditional-exception"].includes(name)) {
      const rows = db.prepare("SELECT * FROM requests ORDER BY rowid").all(),
        p = rows.find((x) => x.path === "/payment")!,
        s = rows.find((x) => x.path === "/shipment")!,
        c = rows.find((x) => x.path === "/customer")!,
        o = rows.find((x) => x.path === "/orders")!;
      assert.ok(Number(c.ended) <= Number(o.started));
      assert.ok(Number(o.ended) <= Number(p.started));
      if (name === "serial") assert.ok(Number(p.ended) <= Number(s.started));
      else
        assert.ok(
          Math.max(Number(p.started), Number(s.started)) <
            Math.min(Number(p.ended), Number(s.ended)),
          "Business HTTP requests must actually overlap",
        );
      const crm = rows.find((x) => x.path === "/crm")!,
        n = rows.find((x) => x.path === "/notify")!;
      assert.ok(Number(crm.ended) <= Number(n.started));
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
      requests = count("requests");
    assert.deepEqual(
      await runToolChain(app!.runtime, {
        request: r,
        model: { provider: provider!, model: model! },
      }),
      result,
    );
    assert.equal(
      spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
      before,
    );
    assert.equal(count("requests"), requests);
    const calls = before + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    assert.ok(result.usage.effectCalls <= r.maxEffects);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      modelCalls: calls,
      crmWrites: count("crm"),
      notifications: count("inbox"),
      graphs: [...new Set(graphs)],
      directory: dir,
      faultInjection: injected > 0,
      children: children.length,
    };
  } finally {
    try {
      await app?.close();
    } finally {
      await demo.service.close();
    }
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
                "HTTP service with separate SQLite CRM, orders and notification inbox",
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
