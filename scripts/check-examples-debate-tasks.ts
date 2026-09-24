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
} from "../examples/_shared/tools/debate/adapters.ts";
import {
  roles,
  type Agent,
  type Report,
} from "../examples/_shared/tools/debate/domain.ts";
import {
  runDebate,
  runDebateLoop,
  scope,
  type Options,
} from "../examples/patterns/debate/index.ts";
import { observedDebate } from "./fixtures/debate-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-debate-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-debate-tasks" },
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
  "tradeoffs",
  "aligned",
  "missing-cost",
  "unsafe",
  "role-models",
  "view-retry",
  "view-exhausted",
  "all-views-failed",
  "wrong-agent",
  "forged-citation",
  "invented-judgment",
  "false-consensus",
  "omitted-view",
  "erased-disagreement",
  "unsafe-approval",
  "max-model-calls",
  "batch-budget",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "view-tampered",
  "cancelled",
  "cancel-after-save",
  "effect-crash",
  "sample-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario = (
      ["aligned", "missing-cost", "unsafe"].includes(name) ? name : "tradeoffs"
    ) as Scenario;
  const r = await createDemo(
      dir,
      {
        maxModelCalls:
          name === "max-model-calls" ? 3 : name === "batch-budget" ? 2 : 12,
        deadlineSeconds: name === "deadline" ? 1 : 600,
      },
      scenario,
    ),
    spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    intervals: { agent: Agent; start: number; end: number }[] = [],
    controller = new AbortController();
  let injected = 0;
  const mc = { provider: provider!, model: model! },
    input = {
      request: r,
      model: mc,
      ...(name === "role-models"
        ? {
            models: Object.fromEntries(
              [...roles, "comparison", "synthesis"].map((a) => [a, mc]),
            ),
          }
        : {}),
    };
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, args, context) {
          spans.push(node);
          const start = Date.now(),
            out = await w.execute(node, args, context);
          if (
            name === "cancel-after-save" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(args).includes('"debate_save"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            const messages = (args as { messages: { content: string }[] })
                .messages,
              data = JSON.parse(messages.at(-1)!.content),
              agent: Agent = data.agent;
            intervals.push({ agent, start, end: Date.now() });
            await writeFile(
              join(
                dir,
                `model-${agent}-${intervals.filter((x) => x.agent === agent).length}.json`,
              ),
              JSON.stringify({ input: args, output: out }, null, 2),
            );
            if (data.phase === "view") {
              assert.equal(data.evidence.agent, agent);
              assert.deepEqual(
                data.evidence.source,
                JSON.parse(await readFile(join(dir, "sources.json"), "utf8")),
              );
              assert.equal(data.views, undefined);
              assert.equal(data.comparison, undefined);
              assert.equal(data.evidence.expected, undefined);
            } else {
              assert.ok(data.views.length > 0);
              assert.ok(
                data.views.every((v: { id: string }) =>
                  /^[a-f0-9]{64}$/.test(v.id),
                ),
              );
            }
            const changed = structuredClone(out) as {
              output: { message: { content: string } };
            };
            const parse = () =>
              JSON.parse(
                changed.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
            if (
              data.phase === "view" &&
              (name === "all-views-failed" ||
                (agent === "reliability" &&
                  [
                    "view-retry",
                    "view-exhausted",
                    "wrong-agent",
                    "forged-citation",
                    "invented-judgment",
                  ].includes(name))) &&
              (name !== "view-retry" || !injected)
            ) {
              if (
                ["view-retry", "view-exhausted", "all-views-failed"].includes(
                  name,
                )
              )
                changed.output.message.content = "injected invalid opinion";
              else {
                const v = parse();
                if (name === "wrong-agent") v.agent = "product";
                else if (name === "forged-citation")
                  v.assessments[0].citations[0].quote = "invented";
                else
                  v.assessments.find(
                    (x: { topic: string }) => x.topic === "reliability",
                  ).judgment = "positive";
                changed.output.message.content = JSON.stringify(v);
              }
              injected++;
              return changed;
            }
            if (
              agent === "comparison" &&
              ["false-consensus", "omitted-view"].includes(name)
            ) {
              const v = parse();
              if (name === "false-consensus")
                for (const t of v.topics) t.kind = "consensus";
              else v.reviewedIds = v.reviewedIds.slice(0, -1);
              changed.output.message.content = JSON.stringify(v);
              injected++;
              return changed;
            }
            if (
              agent === "synthesis" &&
              ["erased-disagreement", "unsafe-approval"].includes(name)
            ) {
              const v = parse();
              if (name === "erased-disagreement") v.unresolvedTopics = [];
              else v.recommendation = "pilot";
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
  let app: Awaited<ReturnType<typeof observedDebate>> | undefined;
  const open = async () =>
    (app = await observedDebate(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(runDebateLoop, [input, options], {
      concurrency: 4,
      ...(options.signal ? { signal: options.signal } : {}),
      onGraph: (e) => {
        if (e.status === "started") graphs.push(e.graphId);
      },
    });
  async function child(phase: string) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/debate-child.ts",
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
      }
      if (name === "cancel-after-save")
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
          "view-tampered",
        ].includes(name)
      ) {
        await run({ stopAfter: "views" });
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          for (const agent of [...roles, "comparison", "synthesis"] as const)
            await app!.storage.redis.pExpire(
              (config.context.cache?.keyPrefix ?? "ditto:context:") +
                contextScopeKey(scope(r, agent)),
              1,
            );
          await delay(10);
        }
        if (name === "redis-unavailable") {
          await app!.storage.redis.quit();
          const n = intervals.length;
          await assert.rejects(run());
          assert.equal(intervals.length, n);
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
                  ? "sources.json"
                  : "policy.json",
            ),
            old = await readFile(path, "utf8"),
            v = JSON.parse(old);
          if (name === "request-changed") v.question += " changed";
          else if (name === "source-changed") v.upliftPercent++;
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          const n = intervals.length;
          await assert.rejects(run());
          assert.equal(intervals.length, n);
          await writeFile(path, old);
        }
        if (name === "view-tampered") {
          const path = join(
              dir,
              "views",
              (await readdir(join(dir, "views")))[0]!,
            ),
            old = await readFile(path, "utf8");
          await writeFile(path, old + " ");
          const n = intervals.length;
          await assert.rejects(run());
          assert.equal(intervals.length, n);
          await writeFile(path, old);
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
    const partial = [
        "view-exhausted",
        "wrong-agent",
        "forged-citation",
        "invented-judgment",
      ].includes(name),
      comparisonFailure = ["false-consensus", "omitted-view"].includes(name),
      synthesisFailure = ["erased-disagreement", "unsafe-approval"].includes(
        name,
      ),
      limited = ["max-model-calls", "batch-budget", "deadline"].includes(name),
      allFailed = name === "all-views-failed";
    assert.equal(
      result.status,
      allFailed || comparisonFailure || synthesisFailure
        ? "needs-human"
        : partial || limited
          ? "partial"
          : "completed",
    );
    assert.equal(
      result.stopReason,
      allFailed
        ? "no-valid-perspectives"
        : comparisonFailure
          ? "comparison-attempts-exhausted"
          : synthesisFailure
            ? "synthesis-attempts-exhausted"
            : partial
              ? "missing-perspectives"
              : limited
                ? name === "batch-budget"
                  ? "max-model-calls"
                  : name
                : "completed",
    );
    await app!.adapters.verify(result);
    if (partial) {
      assert.deepEqual(result.comparison!.matrix.missingAgents, [
        "reliability",
      ]);
      assert.equal(result.synthesis!.recommendation, "defer");
      assert.equal(
        result.comparison!.matrix.topics.find((t) => t.topic === "benefit")!
          .kind,
        "agreement-among-available",
      );
      assert.equal(
        result.entries.find((e) => e.agent === "reliability")!.attempts,
        2,
      );
    }
    if (name === "tradeoffs") {
      assert.equal(
        result.comparison!.matrix.topics.find((t) => t.topic === "benefit")!
          .kind,
        "consensus",
      );
      for (const topic of ["cost", "reliability"]) {
        const t = result.comparison!.matrix.topics.find(
          (t) => t.topic === topic,
        )!;
        assert.equal(t.kind, "disagreement");
        assert.equal(
          t.groups.find((g) => g.judgment === "concern")!.agents.length,
          1,
        );
      }
      const initial = roles.map((a) => intervals.find((i) => i.agent === a)!);
      assert.ok(
        Math.max(...initial.map((x) => x.start)) <
          Math.min(...initial.map((x) => x.end)),
      );
      assert.ok(
        intervals.find((x) => x.agent === "comparison")!.start >=
          Math.max(
            ...intervals
              .filter((x) => roles.includes(x.agent as (typeof roles)[number]))
              .map((x) => x.end),
          ),
      );
    }
    if (name === "aligned")
      assert.ok(
        result.comparison!.matrix.topics.every(
          (t) => t.kind === "consensus" && t.groups[0]!.judgment === "positive",
        ),
      );
    if (name === "missing-cost")
      assert.equal(result.synthesis!.recommendation, "defer");
    if (result.synthesis && name !== "aligned")
      assert.notEqual(result.synthesis.recommendation, "pilot");
    if (name === "view-retry") {
      assert.equal(
        result.entries.find((e) => e.agent === "reliability")!.attempts,
        2,
      );
      for (const a of ["product", "finance"]) {
        assert.equal(result.entries.find((e) => e.agent === a)!.attempts, 1);
      }
    }
    if (name === "batch-budget") assert.equal(intervals.length, 0);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8"),
      csv = await readFile(join(dir, "output/comparison.csv"), "utf8");
    for (const e of result.entries)
      if (e.resultId) {
        const v = await app!.adapters.result(e.resultId);
        assert.ok(md.includes(v.view.summary));
        assert.ok(md.includes(v.view.tradeoff));
        for (const a of v.view.assessments)
          for (const c of a.citations) assert.ok(md.includes(c.quote));
      }
    for (const t of result.comparison?.matrix.topics ?? [])
      assert.ok(csv.includes(`${t.topic},${t.kind}`));
    const before = intervals.length;
    assert.deepEqual(await runDebate(app!.runtime, input), result);
    assert.equal(intervals.length, before);
    const calls = before + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      recommendation: result.synthesis?.recommendation ?? null,
      views: result.entries.filter((e) => e.resultId).length,
      modelCalls: calls,
      intervals,
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
              context: "Redis per perspective",
              memory: "SQLite",
              business:
                "immutable independent opinions, comparison CSV and decision memo",
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
