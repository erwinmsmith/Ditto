import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  symlink,
  rename,
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
import { openValidationTools } from "../examples/_shared/tools/validation/tools.ts";
import {
  createFixture,
  sentinels,
} from "../examples/_shared/tools/validation/fixtures.ts";
import {
  modes,
  digest,
  type Mode,
  type Assessment,
} from "../examples/_shared/tools/validation/domain.ts";
import { sandbox, model } from "../examples/capabilities/validation/cli.ts";
import {
  runValidation,
  scope,
  memoryKey,
  type Report,
  type Options,
} from "../examples/capabilities/validation/shared.ts";
const { values } = parseArgs({
  options: {
    report: {
      type: "string",
      default: ".examples-validation-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-validation-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  selected = model(config);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
const cases = [
  ...modes.map((mode) => ({
    name: mode + "-complete",
    mode,
    variant: "default" as const,
  })),
  ...modes.map((mode) => ({
    name: mode + "-valid-expiry",
    mode,
    variant: "valid" as const,
  })),
  ...[
    "redis-unavailable",
    "memory-unavailable",
    "source-changed",
    "source-symlink",
    "request-changed",
    "wrong-evidence",
    "sensitive-model-output",
    "policy-revoked",
    "cross-tenant",
    "risk-approved",
    "approval-stale",
    "unknown-policy",
    "sandbox-denied",
    "cancelled",
    "material-crash",
    "assessment-crash",
    "effect-crash",
    "report-crash",
    "publication-retry",
    "source-oversized",
    "artifact-tampered",
    "approval-content-changed",
  ].map((name) => ({
    name,
    mode: "redaction" as Mode,
    variant: "valid" as const,
  })),
];
limitCapabilityCases(cases);
function noSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of sentinels)
    assert.ok(!text.includes(s), "Sensitive sentinel escaped ingress");
}
async function runCase(item: (typeof cases)[number]) {
  console.log(JSON.stringify({ name: item.name, event: "started" }));
  const dir = join(directory, item.name),
    r = await createFixture(dir, item.mode, item.variant),
    spans: string[] = [],
    traces: unknown[] = [],
    children: { modelCalls: number }[] = [];
  let fault = "",
    storage = await openAgentStorage(dir, config),
    business = openValidationTools(dir, r);
  function observed(d: WorkerDefinition): WorkerDefinition {
    return {
      ...d,
      instantiate() {
        const w = d.instantiate();
        return {
          async execute(node, input, context) {
            spans.push(node);
            noSecrets(input);
            traces.push(input);
            let result = await w.execute(node, input, context);
            noSecrets(result);
            traces.push(result);
            if (node === "INFER.REASONING.SAMPLE")
              await writeFile(
                join(dir, "model-response.json"),
                JSON.stringify(result, null, 2),
              );
            if (
              node === "INFER.REASONING.SAMPLE" &&
              ["evidence", "secret"].includes(fault)
            ) {
              const clone = structuredClone(result) as {
                output: { message: { content: string } };
              };
              const a = JSON.parse(
                clone.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (fault === "evidence")
                a.dimensions[0].evidence[0].path = "/missing";
              else a.summary = sentinels[3];
              clone.output.message.content = JSON.stringify(a);
              result = clone as typeof result;
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
  const make = () =>
    createDitto({
      config,
      sandbox:
        item.name === "sandbox-denied"
          ? { ...sandbox(config, r), tools: [] }
          : sandbox(config, r),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: business.tools }),
      ].map(observed),
    });
  let runtime = make();
  const entry = await import(`../examples/capabilities/validation/${r.mode}.ts`) as { run: typeof runValidation };
  const run = (options: Options = {}) =>
    entry.run(runtime, { request: r, model: selected }, options);
  const checkpoint = async () => {
    await run({ stopAfter: "assessment" });
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      const row = db
        .prepare("SELECT content FROM memories WHERE memory_key=?")
        .get(memoryKey(r, "assessment"));
      return (JSON.parse(String(row!.content)) as { value: Assessment }).value;
    } finally {
      db.close();
    }
  };
  const child = (phase: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/validation-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
        ],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      p.stdout.on("data", (v) => (output += v));
      p.stderr.on("data", (v) => (output += v));
      const timer = setTimeout(() => p.kill("SIGKILL"), 180000);
      p.on("error", reject);
      p.on("close", async (code, signal) => {
        clearTimeout(timer);
        try {
          noSecrets(output);
          if (phase.endsWith("crash")) assert.equal(signal, "SIGKILL");
          else assert.equal(code, 0, output);
          children.push(
            JSON.parse(
              await readFile(join(dir, `child-${phase}.json`), "utf8"),
            ),
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  let report: Report | undefined;
  try {
    if (item.name.endsWith("crash")) {
      await runtime.close();
      business.close();
      await storage.close();
      await child(item.name);
      await child("resume");
      storage = await openAgentStorage(dir, config);
      business = openValidationTools(dir, r);
      runtime = make();
      report = (await run()) as Report;
      assert.equal(business.countEffects(), 1);
      if (item.name !== "material-crash")
        assert.equal(children[1]!.modelCalls, 0);
    } else if (item.name === "redis-unavailable") {
      await storage.redis.quit();
      await assert.rejects(() => run());
      assert.equal(spans.includes("INFER.REASONING.SAMPLE"), false);
    } else if (item.name === "memory-unavailable") {
      const db = new DatabaseSync(join(dir, "memory.sqlite"));
      try {
        db.exec("ALTER TABLE memories RENAME TO missing_memories");
        await assert.rejects(() => run());
        assert.equal(business.countEffects(), 0);
        db.exec("ALTER TABLE missing_memories RENAME TO memories");
      } finally {
        db.close();
      }
    } else if (item.name === "source-changed") {
      await checkpoint();
      await writeFile(join(dir, "source.json"), "{}");
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 0);
    } else if (item.name === "source-symlink") {
      await rename(join(dir, "source.json"), join(dir, "other.json"));
      await symlink(join(dir, "other.json"), join(dir, "source.json"));
      await assert.rejects(() => run());
    } else if (item.name === "source-oversized") {
      await writeFile(join(dir, "source.json"), "x".repeat(32001));
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 0);
    } else if (item.name === "artifact-tampered") {
      const completed = (await run()) as Report;
      await writeFile(join(dir, completed.file), "modified");
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 1);
    } else if (item.name === "approval-content-changed") {
      business.setPolicy({
        ...business.current(),
        revision: 2,
        reversible: false,
      });
      const a = await checkpoint();
      await business.approve(
        { ...a, summary: "Different reviewed version" },
        "trusted-reviewer",
      );
      report = (await run()) as Report;
      assert.equal(report.receipt.status, "confirmation-required");
      assert.equal(business.countEffects(), 0);
    } else if (item.name === "request-changed") {
      await checkpoint();
      await assert.rejects(() =>
        runValidation(runtime, {
          request: { ...r, sourceHash: "a".repeat(64) },
          model: selected,
        }),
      );
    } else if (
      item.name === "wrong-evidence" ||
      item.name === "sensitive-model-output"
    ) {
      fault = item.name === "wrong-evidence" ? "evidence" : "secret";
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 0);
    } else if (item.name === "sandbox-denied") {
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 0);
    } else if (item.name === "cancelled") {
      await assert.rejects(() => run({ signal: AbortSignal.abort() }));
      assert.equal(spans.length, 0);
    } else if (item.name === "unknown-policy") {
      await checkpoint();
      const db = new DatabaseSync(join(dir, "business.sqlite"));
      try {
        db.prepare("UPDATE policy SET value=?").run(
          JSON.stringify({ ...business.current(), reversible: "unknown" }),
        );
      } finally {
        db.close();
      }
      await assert.rejects(() => run());
      assert.equal(business.countEffects(), 0);
    } else {
      if (item.name === "policy-revoked" || item.name === "cross-tenant") {
        await checkpoint();
        business.setPolicy({
          ...business.current(),
          revision: 2,
          ...(item.name === "policy-revoked"
            ? { role: "reader" as const }
            : { targetTenant: "other" }),
        });
      }
      if (item.name === "risk-approved" || item.name === "approval-stale") {
        business.setPolicy({
          ...business.current(),
          revision: 2,
          reversible: false,
        });
        const a = await checkpoint();
        const waiting = (await run()) as Report;
        assert.equal(waiting.receipt.status, "confirmation-required");
        assert.equal(business.countEffects(), 0);
        await assert.rejects(() => business.approve(a, "untrusted-user"));
        await business.approve(a, "trusted-reviewer");
        if (item.name === "approval-stale")
          business.setPolicy({
            ...business.current(),
            revision: 3,
            target: "different-target",
          });
      }
      if (item.name.endsWith("valid-expiry")) {
        await checkpoint();
        const key =
          (config.context.cache?.keyPrefix ?? "ditto:context:") +
          contextScopeKey(scope(r));
        await storage.redis.pExpire(key, 1);
        await delay(20);
        assert.equal(await storage.redis.get(key), null);
        await runtime.close();
        business.close();
        await storage.close();
        storage = await openAgentStorage(dir, config);
        business = openValidationTools(dir, r);
        runtime = make();
      }
      report = (await run()) as Report;
      const expected =
        item.name === "approval-stale" || item.name === "risk-complete"
          ? "confirmation-required"
          : item.name === "policy-revoked" ||
              item.name === "cross-tenant" ||
              (item.variant === "default" &&
                !["risk", "sensitive-data", "redaction"].includes(item.mode))
            ? "denied"
            : "published";
      assert.equal(report.receipt.status, expected);
      assert.equal(business.countEffects(), expected === "published" ? 1 : 0);
      if (item.name === "publication-retry") {
        const calls = spans.filter(
          (n) => n === "INFER.REASONING.SAMPLE",
        ).length;
        assert.deepEqual(await run(), report);
        assert.equal(business.countEffects(), 1);
        assert.equal(
          spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
          calls,
        );
      }
      if (item.name.endsWith("valid-expiry"))
        assert.equal(
          spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
          1,
        );
    }
    if (report) {
      const content = await readFile(join(dir, report.file), "utf8");
      assert.equal(digest(content), report.sha256);
      noSecrets(content);
      assert.ok(report.material.findings.length >= 6);
    }
    const key =
      (config.context.cache?.keyPrefix ?? "ditto:context:") +
      contextScopeKey(scope(r));
    if (storage.redis.isOpen) noSecrets(await storage.redis.get(key));
    for (const name of await readdir(dir)) {
      if (/^(memory|business)\.sqlite/.test(name))
        for (const secret of sentinels)
          assert.ok(
            !(await readFile(join(dir, name))).includes(Buffer.from(secret)),
            `Secret in ${name}`,
          );
    }
    noSecrets(traces);
    await writeFile(
      join(dir, "safe-trace.json"),
      JSON.stringify(traces, null, 2),
    );
    return {
      name: item.name,
      passed: true,
      modelCalls:
        spans.filter((n) => n === "INFER.REASONING.SAMPLE").length +
        children.reduce((n, c) => n + c.modelCalls, 0),
      ...(report
        ? {
            status: report.receipt.status,
            effects: business.countEffects(),
            artifact: report.file,
          }
        : {}),
      sensitiveSinkAudit: true,
    };
  } finally {
    await runtime.close();
    business.close();
    await storage.close();
  }
}
for (let i = 0; i < cases.length; i += 3) {
  const batch = await Promise.all(
    cases.slice(i, i + 3).map(async (item) => {
      try {
        return await runCase(item);
      } catch (e) {
        return {
          name: item.name,
          passed: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  results.push(...batch);
  await writeFile(
    resolve(values.report!),
    JSON.stringify(
      {
        startedAt,
        directory,
        model: selected,
        context: "Redis",
        memory: "SQLite",
        business: "separate SQLite publication ledger",
        results,
      },
      null,
      2,
    ),
  );
  for (const r of batch) console.log(JSON.stringify(r));
}
const failed = results.filter((r) => !r.passed);
console.log(
  JSON.stringify({
    passed: results.length - failed.length,
    total: results.length,
    modelCalls: results.reduce((n, r) => n + Number(r.modelCalls ?? 0), 0),
  }),
);
if (failed.length) process.exitCode = 1;
