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
  flawedDraft,
  type Scenario,
} from "../examples/_shared/tools/reflection/adapters.ts";
import {
  check,
  type Report,
} from "../examples/_shared/tools/reflection/domain.ts";
import {
  runReflection,
  runReflectionLoop,
  scope,
  type Options,
} from "../examples/patterns/reflection/index.ts";
import { observedReflection } from "./fixtures/reflection-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-reflection-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-reflection-tasks" },
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
  "generate",
  "flawed-draft",
  "missing-data",
  "english",
  "false-pass",
  "no-progress",
  "invalid-draft",
  "invalid-review",
  "max-rounds",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "draft-tampered",
  "check-tampered",
  "cancelled",
  "cancel-after-review",
  "effect-crash",
  "draft-1-crash",
  "review-1-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name);
  const scenario: Scenario =
    name === "missing-data"
      ? "missing-data"
      : ["generate", "invalid-draft", "deadline"].includes(name)
        ? "generate"
        : "flawed-draft";
  const r = await createDemo(dir, scenario, {
    maxRounds: name === "max-rounds" ? 1 : 4,
    maxModelCalls: name === "max-model-calls" ? 1 : 8,
    deadlineSeconds: name === "deadline" ? 1 : 600,
    ...(name === "english"
      ? {
          goal: "Create a concise monthly business report with verified net revenue growth, limitations, proposed actions and exact source citations.",
        }
      : {}),
  });
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  let injected = 0;
  const controller = new AbortController();
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const out = await w.execute(node, input, context);
          if (
            name === "cancel-after-review" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"reflection_save_review"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((n) => n === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            const isReview = JSON.stringify(input).includes(
              "Review the specified draft",
            );
            const changed = structuredClone(out) as {
              output: { message: { content: string } };
            };
            if (name === "invalid-draft" && !isReview) {
              changed.output.message.content = "not JSON";
              injected++;
              return changed;
            }
            if (name === "no-progress" && !isReview) {
              changed.output.message.content = JSON.stringify(flawedDraft);
              injected++;
              return changed;
            }
            if (
              isReview &&
              ["false-pass", "invalid-review"].includes(name) &&
              !injected
            ) {
              const v = JSON.parse(
                changed.output.message.content
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (name === "false-pass") {
                v.verdict = "pass";
                v.issues = [];
              } else v.draftId = "0".repeat(64);
              changed.output.message.content = JSON.stringify(v);
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
  let app: Awaited<ReturnType<typeof observedReflection>> | undefined;
  const open = async () =>
    (app = await observedReflection(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(
      runReflectionLoop,
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
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/reflection-child.ts",
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
      if (name === "cancel-after-review")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "request-changed",
          "source-changed",
          "permission-revoked",
          "deadline",
        ].includes(name)
      ) {
        await run({ stopAfter: "draft" });
        if (name === "redis-expiry") {
          // Seeded drafts need no initial model; load Context explicitly via the normal review checkpoint first.
          await run({ stopAfter: "review" });
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
                  ? "sales.csv"
                  : "policy.json",
            ),
            saved = await readFile(path, "utf8");
          let modified: string;
          if (name === "source-changed")
            modified = saved.replace("150000", "250000");
          else {
            const v = JSON.parse(saved);
            if (name === "request-changed") v.goal += " changed";
            else v.enabled = false;
            modified = JSON.stringify(v);
          }
          await writeFile(path, modified);
          await assert.rejects(run());
          await writeFile(path, saved);
        }
        if (name === "deadline") await delay(1100);
      }
      if (["draft-tampered", "check-tampered"].includes(name)) {
        await run({
          stopAfter: name === "draft-tampered" ? "draft" : "review",
        });
        const sub = name === "draft-tampered" ? "drafts" : "checks",
          path = join(dir, sub, (await readdir(join(dir, sub)))[0]!),
          saved = await readFile(path, "utf8");
        await writeFile(path, saved + " ");
        if (sub === "drafts") {
          const v = JSON.parse(saved);
          v.metrics.currentNetCents++;
          await writeFile(path, JSON.stringify(v));
        }
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
    const stops = [
      "max-rounds",
      "max-model-calls",
      "deadline",
      "invalid-draft",
      "invalid-review",
      "no-progress",
    ];
    if (stops.includes(name)) {
      assert.equal(result.status, "partial");
      assert.equal(result.stopReason, name);
      assert.equal(result.acceptedDraftId, null);
      await assert.rejects(access(join(dir, "output/analysis.json")));
    } else if (name === "missing-data") {
      assert.equal(result.status, "needs-human");
      assert.equal(result.stopReason, "missing-data");
      assert.equal(result.rounds.length, 0);
    } else {
      assert.equal(result.status, "completed");
      assert.ok(result.acceptedDraftId);
      const analysis = JSON.parse(
        await readFile(join(dir, "output/analysis.json"), "utf8"),
      );
      assert.equal(analysis.metrics.baselineNetCents, 114000);
      assert.equal(analysis.metrics.currentNetCents, 141000);
      assert.equal(analysis.metrics.growthPercent, 23.68);
      assert.deepEqual(check(analysis, await app!.adapters.load()), []);
      assert.equal(result.rounds.at(-1)!.review.verdict, "pass");
      if (scenario === "flawed-draft") {
        assert.ok(result.rounds.length >= 2);
        assert.ok(result.rounds[0]!.issues.length >= 5);
        assert.notEqual(result.rounds[0]!.draftId, result.acceptedDraftId);
      }
    }
    if (name === "false-pass") {
      assert.equal(result.rounds[0]!.review.verdict, "pass");
      assert.ok(result.rounds[0]!.issues.length);
      assert.ok(result.rounds.length > 1);
    }
    if (
      ["invalid-draft", "invalid-review", "false-pass", "no-progress"].includes(
        name,
      )
    )
      assert.equal(injected, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    assert.deepEqual(
      await runReflection(app!.runtime, {
        request: r,
        model: { provider: provider!, model: model! },
      }),
      result,
    );
    assert.equal(
      spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
      before,
    );
    const calls = before + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      modelCalls: calls,
      rounds: result.rounds.length,
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
          business: "CSV and immutable artifacts",
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results.at(-1)));
}
if (results.some((r) => r.status !== "passed")) process.exitCode = 1;
