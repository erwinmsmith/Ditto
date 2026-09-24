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
import { createDemo } from "../examples/_shared/tools/multi-agent/adapters.ts";
import {
  specialists,
  summary,
  type Report,
  type Agent,
  type Handoff,
} from "../examples/_shared/tools/multi-agent/domain.ts";
import {
  runMultiAgent,
  runMultiAgentLoop,
  scope,
  type Options,
} from "../examples/patterns/multi-agent/index.ts";
import { observedMultiAgent } from "./fixtures/multi-agent-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-multi-agent-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-multi-agent-tasks" },
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
  "parallel",
  "serial",
  "ready",
  "role-models",
  "invalid-plan",
  "unknown-agent",
  "cycle-plan",
  "agent-retry",
  "agent-failed",
  "serial-dependency-failed",
  "wrong-agent",
  "citation-forgery",
  "invalid-synthesis",
  "missing-handoff",
  "all-agents-failed",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "source-changed",
  "request-changed",
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
    r = await createDemo(
      dir,
      {
        mode:
          name === "serial" || name === "serial-dependency-failed"
            ? "serial"
            : "parallel",
        maxModelCalls: name === "max-model-calls" ? 3 : 8,
        deadlineSeconds: name === "deadline" ? 1 : 600,
      },
      name === "ready",
    );
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    intervals: { agent: Agent; start: number; end: number }[] = [],
    controller = new AbortController();
  let injected = 0;
  const roleModel = { provider: provider!, model: model! },
    input = {
      request: r,
      model: roleModel,
      ...(name === "role-models"
        ? {
            models: {
              planner: roleModel,
              engineering: roleModel,
              operations: roleModel,
              synthesis: roleModel,
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
          const start = Date.now();
          const out = await w.execute(node, args, context);
          if (
            name === "cancel-after-save" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(args).includes('"team_save"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            const messages = (args as { messages: { content: string }[] })
                .messages,
              data = JSON.parse(messages.at(-1)!.content),
              agent: Agent = data.agents
                ? "planner"
                : data.handoffs && !data.evidence
                  ? "synthesis"
                  : data.assignment.id;
            intervals.push({ agent, start, end: Date.now() });
            await writeFile(
              join(
                dir,
                `model-${agent}-${intervals.filter((x) => x.agent === agent).length}.json`,
              ),
              JSON.stringify({ input: args, output: out }, null, 2),
            );
            if (specialists.includes(agent as (typeof specialists)[number])) {
              assert.equal(data.evidence.agent, agent);
              assert.ok(
                !JSON.stringify(data.evidence).includes(
                  agent === "engineering" ? "On-call assigned" : "tests passed",
                ),
              );
              if (r.mode === "parallel") assert.deepEqual(data.handoffs, []);
              else if (agent === "operations") {
                assert.equal(data.handoffs.length, 1);
                assert.equal(data.handoffs[0].finding.agent, "engineering");
              }
            }
            const changed = structuredClone(out) as {
              output: { message: { content: string } };
            };
            if (
              agent === "planner" &&
              ["invalid-plan", "unknown-agent", "cycle-plan"].includes(name)
            ) {
              if (name === "invalid-plan")
                changed.output.message.content = "not JSON";
              else {
                const v = JSON.parse(
                  changed.output.message.content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                if (name === "unknown-agent") v.tasks[0].agent = "unregistered";
                else v.tasks[0].dependsOn = ["operations"];
                changed.output.message.content = JSON.stringify(v);
              }
              injected++;
              return changed;
            }
            if (
              (agent === "engineering" &&
                ([
                  "agent-failed",
                  "serial-dependency-failed",
                  "wrong-agent",
                  "citation-forgery",
                ].includes(name) ||
                  (name === "agent-retry" && !injected))) ||
              (specialists.includes(agent as (typeof specialists)[number]) &&
                name === "all-agents-failed")
            ) {
              if (["wrong-agent", "citation-forgery"].includes(name)) {
                const v = JSON.parse(
                  changed.output.message.content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                if (name === "wrong-agent") v.agent = "operations";
                else v.citations[0].quote = "fabricated evidence";
                changed.output.message.content = JSON.stringify(v);
              } else
                changed.output.message.content =
                  "injected invalid specialist response";
              injected++;
              return changed;
            }
            if (
              agent === "synthesis" &&
              ["invalid-synthesis", "missing-handoff"].includes(name)
            ) {
              if (name === "invalid-synthesis")
                changed.output.message.content = "not JSON";
              else {
                const v = JSON.parse(
                  changed.output.message.content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                v.sections[0].resultId = "0".repeat(64);
                changed.output.message.content = JSON.stringify(v);
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
  let app: Awaited<ReturnType<typeof observedMultiAgent>> | undefined;
  const open = async () =>
    (app = await observedMultiAgent(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(runMultiAgentLoop, [input, options], {
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
          "scripts/fixtures/multi-agent-child.ts",
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
        await run({ stopAfter: name === "deadline" ? "plan" : "specialists" });
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          for (const agent of [
            "planner",
            ...specialists,
            "synthesis",
          ] as const) {
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
          if (name === "source-changed") v.engineering.passed = 49;
          else if (name === "request-changed") v.goal += " changed";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await writeFile(path, old);
        }
      }
      if (name === "result-tampered") {
        await run({ stopAfter: "report" });
        const path = join(
            dir,
            "results",
            (await readdir(join(dir, "results")))[0]!,
          ),
          old = await readFile(path, "utf8");
        await writeFile(path, old + " ");
        await assert.rejects(run());
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
    const invalidPlan = [
        "invalid-plan",
        "unknown-agent",
        "cycle-plan",
      ].includes(name),
      partial = [
        "agent-failed",
        "serial-dependency-failed",
        "wrong-agent",
        "citation-forgery",
        "invalid-synthesis",
        "missing-handoff",
        "all-agents-failed",
        "max-model-calls",
        "deadline",
      ].includes(name);
    assert.equal(
      result.status,
      invalidPlan ? "needs-human" : partial ? "partial" : "completed",
    );
    if (invalidPlan) {
      assert.equal(result.stopReason, "invalid-plan");
      assert.equal(intervals.length, 1);
    }
    const handoffs: Handoff[] = [];
    for (const entry of result.entries)
      if (entry.resultId) {
        const saved = await app!.adapters.result(entry.resultId);
        assert.equal(saved.finding.agent, entry.agent);
        handoffs.push({ resultId: entry.resultId, finding: saved.finding });
      }
    if (result.summary)
      assert.deepEqual(summary(result.summary, handoffs), result.summary);
    if (result.status === "completed") {
      assert.equal(handoffs.length, 2);
      assert.equal(
        result.summary!.verdict,
        name === "ready" ? "ready" : "blocked",
      );
      assert.deepEqual(result.summary!.missingAgents, []);
    }
    if (["agent-failed", "wrong-agent", "citation-forgery"].includes(name)) {
      assert.equal(handoffs.length, 1);
      assert.equal(result.summary!.verdict, "incomplete");
      assert.deepEqual(result.summary!.missingAgents, ["engineering"]);
      assert.equal(intervals.filter((x) => x.agent === "operations").length, 1);
    }
    if (name === "agent-retry") {
      assert.equal(
        intervals.filter((x) => x.agent === "engineering").length,
        2,
      );
      assert.equal(intervals.filter((x) => x.agent === "operations").length, 1);
    }
    if (name === "serial-dependency-failed") {
      assert.equal(result.entries[1]!.status, "blocked");
      assert.equal(intervals.filter((x) => x.agent === "operations").length, 0);
    }
    if (["max-model-calls", "deadline"].includes(name)) {
      assert.equal(result.stopReason, name);
      assert.equal(result.summary, null);
    }
    if (["parallel", "serial", "role-models"].includes(name)) {
      const e = intervals.find((x) => x.agent === "engineering")!,
        o = intervals.find((x) => x.agent === "operations")!,
        s = intervals.find((x) => x.agent === "synthesis")!,
        p = intervals.find((x) => x.agent === "planner")!;
      assert.ok(p.end <= Math.min(e.start, o.start));
      assert.ok(s.start >= Math.max(e.end, o.end));
      if (r.mode === "serial") assert.ok(e.end <= o.start);
      else
        assert.ok(
          Math.max(e.start, o.start) < Math.min(e.end, o.end),
          "Actual specialist model requests must overlap",
        );
    }
    if (name === "redis-expiry")
      for (const agent of [...specialists, "synthesis"] as const)
        assert.ok(
          await app!.storage.redis.get(
            (config.context.cache?.keyPrefix ?? "ditto:context:") +
              contextScopeKey(scope(r, agent)),
          ),
        );
    assert.equal(
      new Set(
        (["planner", ...specialists, "synthesis"] as const).map((a) =>
          contextScopeKey(scope(r, a)),
        ),
      ).size,
      4,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8");
    for (const h of handoffs)
      for (const c of h.finding.citations) assert.ok(md.includes(c.quote));
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    assert.deepEqual(await runMultiAgent(app!.runtime, input), result);
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
      verdict: result.summary?.verdict ?? null,
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
                "scoped release evidence, immutable specialist handoffs and actual report files",
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
