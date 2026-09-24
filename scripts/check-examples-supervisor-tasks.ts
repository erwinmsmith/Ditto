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
} from "../examples/_shared/tools/supervisor/adapters.ts";
import {
  roles,
  type Report,
  type Agent,
} from "../examples/_shared/tools/supervisor/domain.ts";
import {
  runSupervisor,
  runSupervisorLoop,
  scope,
  type Options,
} from "../examples/patterns/supervisor/index.ts";
import { observedSupervisor } from "./fixtures/supervisor-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-supervisor-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-supervisor-tasks" },
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
  "recheck",
  "ready",
  "still-blocked",
  "missing-verification",
  "operations-blocked",
  "role-models",
  "agent-retry",
  "agent-exhausted",
  "invalid-supervisor",
  "unknown-agent",
  "premature-finish",
  "stale-review",
  "redelegate-success",
  "wrong-agent",
  "forged-citation",
  "max-rounds",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "result-tampered",
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
      [
        "ready",
        "still-blocked",
        "missing-verification",
        "operations-blocked",
      ].includes(name)
        ? name
        : "recheck"
    ) as Scenario,
    r = await createDemo(
      dir,
      {
        maxRounds: name === "max-rounds" ? 1 : 6,
        maxModelCalls: name === "max-model-calls" ? 3 : 12,
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
  const modelConfig = { provider: provider!, model: model! },
    input = {
      request: r,
      model: modelConfig,
      ...(name === "role-models"
        ? {
            models: {
              supervisor: modelConfig,
              engineering: modelConfig,
              operations: modelConfig,
              verification: modelConfig,
            },
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
            JSON.stringify(args).includes('"sup_save"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            const messages = (args as { messages: { content: string }[] })
                .messages,
              data = JSON.parse(messages.at(-1)!.content),
              agent: Agent = data.state ? "supervisor" : data.assignment.agent;
            intervals.push({ agent, start, end: Date.now() });
            await writeFile(
              join(
                dir,
                `model-${agent}-${intervals.filter((x) => x.agent === agent).length}.json`,
              ),
              JSON.stringify({ input: args, output: out }, null, 2),
            );
            if (agent !== "supervisor") {
              assert.equal(data.evidence.agent, agent);
              if (agent === "verification") {
                assert.equal(data.parent.finding.agent, "engineering");
                assert.equal(data.parent.finding.verdict, "blocked");
              } else {
                assert.equal(data.parent, null);
                assert.ok(
                  !JSON.stringify(data.evidence).includes(
                    agent === "engineering"
                      ? "On-call assigned"
                      : "tests passed",
                  ),
                );
              }
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
              agent === "supervisor" &&
              [
                "invalid-supervisor",
                "unknown-agent",
                "premature-finish",
              ].includes(name) &&
              !injected
            ) {
              if (name === "invalid-supervisor")
                changed.output.message.content = "not JSON";
              else {
                const v = parse();
                if (name === "unknown-agent")
                  v.assignments[0].agent = "intruder";
                else {
                  v.action = "finish";
                  v.assignments = [];
                  v.conclusion = {
                    verdict: "ready",
                    summary: "Injected premature finish",
                    evidenceIds: [],
                  };
                }
                changed.output.message.content = JSON.stringify(v);
              }
              injected++;
              return changed;
            }
            if (
              agent === "supervisor" &&
              Object.keys(data.state.results).length &&
              ["stale-review", "redelegate-success"].includes(name) &&
              !injected
            ) {
              const v = parse();
              if (name === "stale-review") v.reviewedIds = [];
              else {
                v.action = "delegate";
                v.assignments = [
                  { agent: "engineering", task: "Repeat successful agent" },
                ];
                v.conclusion = null;
              }
              changed.output.message.content = JSON.stringify(v);
              injected++;
              return changed;
            }
            if (
              agent === "engineering" &&
              (["agent-exhausted", "wrong-agent", "forged-citation"].includes(
                name,
              ) ||
                (name === "agent-retry" && !injected))
            ) {
              if (name === "wrong-agent" || name === "forged-citation") {
                const v = parse();
                if (name === "wrong-agent") v.agent = "operations";
                else v.citations[0].quote = "invented evidence";
                changed.output.message.content = JSON.stringify(v);
              } else changed.output.message.content = "injected invalid result";
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
  let app: Awaited<ReturnType<typeof observedSupervisor>> | undefined;
  const open = async () =>
    (app = await observedSupervisor(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(runSupervisorLoop, [input, options], {
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
          "scripts/fixtures/supervisor-child.ts",
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
          "source-changed",
          "request-changed",
          "permission-revoked",
        ].includes(name)
      ) {
        await run({
          stopAfter: name === "deadline" ? "decision" : "delegation",
        });
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          for (const agent of ["supervisor", ...roles] as const) {
            const key =
              (config.context.cache?.keyPrefix ?? "ditto:context:") +
              contextScopeKey(scope(r, agent));
            await app!.storage.redis.pExpire(key, 1);
          }
          await delay(10);
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
          ["source-changed", "request-changed", "permission-revoked"].includes(
            name,
          )
        ) {
          const path = join(
              dir,
              name === "source-changed"
                ? "sources.json"
                : name === "request-changed"
                  ? "request.json"
                  : "policy.json",
            ),
            old = await readFile(path, "utf8"),
            v = JSON.parse(old);
          if (name === "source-changed") v.base.engineering.passed = 49;
          else if (name === "request-changed") v.goal += " changed";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await writeFile(path, old);
        }
      }
      if (name === "result-tampered") {
        await run({ stopAfter: "delegation" });
        const path = join(
            dir,
            "results",
            (await readdir(join(dir, "results")))[0]!,
          ),
          old = await readFile(path, "utf8"),
          calls = intervals.length;
        await writeFile(path, old + " ");
        await assert.rejects(run());
        assert.equal(intervals.length, calls);
        await writeFile(path, old);
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
        "invalid-supervisor",
        "unknown-agent",
        "premature-finish",
        "stale-review",
        "redelegate-success",
      ].includes(name),
      human = [
        "missing-verification",
        "agent-exhausted",
        "wrong-agent",
        "forged-citation",
      ].includes(name),
      limited = ["max-rounds", "max-model-calls", "deadline"].includes(name);
    assert.equal(
      result.status,
      invalid || human ? "needs-human" : limited ? "partial" : "completed",
    );
    assert.equal(
      result.stopReason,
      invalid
        ? "invalid-supervisor-decision"
        : human
          ? "supervisor-escalated"
          : limited
            ? name
            : "completed",
    );
    await app!.adapters.verify(result);
    if (result.status === "completed") {
      assert.equal(result.rounds.at(-1)!.decision.action, "finish");
      assert.equal(
        result.conclusion!.verdict,
        ["still-blocked", "operations-blocked"].includes(name)
          ? "blocked"
          : "ready",
      );
    }
    if (["recheck", "still-blocked", "missing-verification"].includes(name)) {
      assert.ok(
        result.rounds.some((x) =>
          x.decision.assignments.some((a) => a.agent === "verification"),
        ),
      );
      assert.equal(result.state.attempts.engineering, 1);
      assert.equal(result.state.attempts.operations, 1);
      assert.equal(result.state.attempts.verification, 1);
      assert.equal(
        result.state.results.engineering!.finding.verdict,
        "blocked",
      );
      assert.equal(
        (
          await app!.adapters.result(
            result.state.results.verification!.resultId,
          )
        ).parentId,
        result.state.results.engineering!.resultId,
      );
    }
    if (["ready", "operations-blocked"].includes(name)) {
      assert.equal(result.state.attempts.verification, 0);
      assert.equal(
        intervals.filter((x) => x.agent === "verification").length,
        0,
      );
    }
    if (name === "agent-retry") {
      assert.equal(result.state.attempts.engineering, 2);
      assert.equal(result.state.attempts.operations, 1);
      const repeat = result.rounds.find(
        (x) =>
          x.round > 1 &&
          x.decision.assignments.some((a) => a.agent === "engineering"),
      )!;
      assert.ok(repeat);
      assert.ok(
        !repeat.decision.assignments.some((a) => a.agent === "operations"),
      );
    }
    if (["agent-exhausted", "wrong-agent", "forged-citation"].includes(name)) {
      assert.equal(result.state.attempts.engineering, 2);
      assert.equal(result.state.attempts.operations, 1);
      assert.equal(result.state.attempts.verification, 0);
      assert.ok(result.state.results.operations);
      assert.equal(result.conclusion, null);
    }
    if (name === "recheck") {
      const e = intervals.find((x) => x.agent === "engineering")!,
        o = intervals.find((x) => x.agent === "operations")!,
        v = intervals.find((x) => x.agent === "verification")!,
        checks = intervals.filter((x) => x.agent === "supervisor");
      assert.ok(Math.max(e.start, o.start) < Math.min(e.end, o.end));
      assert.ok(checks[1]!.start >= Math.max(e.end, o.end));
      assert.ok(v.start >= checks[1]!.end);
      assert.ok(checks.at(-1)!.start >= v.end);
    }
    if (name === "redis-expiry")
      for (const agent of ["supervisor", ...roles] as const)
        assert.ok(
          await app!.storage.redis.get(
            (config.context.cache?.keyPrefix ?? "ditto:context:") +
              contextScopeKey(scope(r, agent)),
          ),
        );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8");
    for (const h of Object.values(result.state.results))
      for (const c of h.finding.citations) assert.ok(md.includes(c.quote));
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    assert.deepEqual(await runSupervisor(app!.runtime, input), result);
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
      verdict: result.conclusion?.verdict ?? null,
      rounds: result.rounds.length,
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
              context: "Redis with per-agent scopes",
              memory: "SQLite",
              business:
                "initial evidence, later rerun records, immutable handoffs and actual supervisor report",
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
