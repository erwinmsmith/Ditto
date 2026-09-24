import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { graph, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import {
  createDemo,
  type Scenario,
} from "../examples/_shared/tools/specialist-routing/adapters.ts";
import {
  roles,
  type Report,
  type Agent,
  type Specialist,
} from "../examples/_shared/tools/specialist-routing/domain.ts";
import {
  runSpecialistRouting,
  runSpecialistRoutingLoop,
  scope,
  type Options,
} from "../examples/patterns/specialist-routing/index.ts";
import { json } from "../examples/_shared/tools/evidence.ts";
import { observedSpecialistRouting } from "./fixtures/specialist-routing-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-specialist-routing-tasks-live-results.json",
    },
    "output-dir": {
      type: "string",
      default: ".examples-specialist-routing-tasks",
    },
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
  "finance",
  "legal",
  "data",
  "coding",
  "ambiguous",
  "unsupported",
  "role-models",
  "role-denied",
  "low-confidence",
  "route-retry",
  "invalid-route",
  "unknown-role",
  "intent-mismatch",
  "semantic-mismatch",
  "specialist-retry",
  "wrong-specialist",
  "wrong-action",
  "forged-citation",
  "wrong-answer",
  "cross-role",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "sales-unavailable",
  "sales-changed",
  "code-changed",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "route-tampered",
  "artifact-tampered",
  "cancelled",
  "cancel-after-execute",
  "route-crash",
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
      name === "role-denied"
        ? "finance"
        : ["code-changed", "effect-crash"].includes(name)
          ? "coding"
          : [...roles, "ambiguous", "unsupported"].includes(name)
            ? name
            : "data"
    ) as Scenario;
  const r = await createDemo(
    dir,
    {
      maxModelCalls: name === "max-model-calls" ? 1 : 10,
      deadlineSeconds: name === "deadline" ? 1 : 600,
      ...(name === "role-denied"
        ? { allowedRoles: ["data" as Specialist] }
        : {}),
    },
    scenario,
  );
  const intervals: {
      agent: Agent;
      phase: string;
      start: number;
      end: number;
    }[] = [],
    spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    controller = new AbortController();
  let injected = 0;
  const mc = { provider: provider!, model: model! },
    input = {
      request: r,
      model: mc,
      ...(name === "role-models"
        ? {
            models: Object.fromEntries(
              ["router", ...roles].map((a) => [a, mc]),
            ),
          }
        : {}),
    };
  const observe = (definition: WorkerDefinition): WorkerDefinition => ({
    ...definition,
    instantiate() {
      const w = definition.instantiate();
      return {
        async execute(node, args, context) {
          spans.push(node);
          const start = Date.now(),
            out = await w.execute(node, args, context);
          if (
            name === "cancel-after-execute" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(args).includes('"routing_execute"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            const messages = (args as { messages: { content: string }[] })
                .messages,
              data = JSON.parse(messages.at(-1)!.content),
              agent: Agent = data.agent;
            intervals.push({
              agent,
              phase: data.phase,
              start,
              end: Date.now(),
            });
            await writeFile(
              join(dir, `model-${intervals.length}.json`),
              JSON.stringify({ input: args, output: out }, null, 2),
            );
            if (agent === "router") {
              assert.equal(data.data.evidence, undefined);
              assert.equal(data.data.result, undefined);
            } else if (data.phase === "specialist") {
              assert.equal(data.data.evidence.role, agent);
              assert.ok(data.data.evidence.facts.length > 0);
            } else {
              assert.equal(data.data.result.role, agent);
              assert.ok(data.data.result.facts.length > 0);
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
              data.phase === "route" &&
              [
                "low-confidence",
                "route-retry",
                "invalid-route",
                "unknown-role",
                "intent-mismatch",
                "semantic-mismatch",
              ].includes(name) &&
              (name !== "route-retry" || !injected)
            ) {
              if (["route-retry", "invalid-route"].includes(name))
                changed.output.message.content = "injected invalid JSON";
              else {
                const v = parse();
                if (name === "low-confidence") {
                  v.confidence = 0.2;
                  v.question = "请确认是否需要查询 sales 中的已支付订单？";
                } else if (name === "unknown-role") v.domains = ["intruder"];
                else if (name === "semantic-mismatch") {
                  v.domains = ["finance"];
                  v.intent = "reimbursement";
                } else v.intent = "reimbursement";
                changed.output.message.content = JSON.stringify(v);
              }
              injected++;
              return changed;
            }
            if (
              data.phase === "specialist" &&
              [
                "specialist-retry",
                "wrong-specialist",
                "wrong-action",
                "forged-citation",
              ].includes(name) &&
              (name !== "specialist-retry" || !injected)
            ) {
              if (name === "specialist-retry")
                changed.output.message.content = "injected invalid JSON";
              else {
                const v = parse();
                if (name === "wrong-specialist") v.role = "finance";
                else if (name === "wrong-action")
                  v.action = "run-arbitrary-command";
                else v.citations[0].quote = "forged";
                changed.output.message.content = JSON.stringify(v);
              }
              injected++;
              return changed;
            }
            if (name === "wrong-answer" && data.phase === "answer") {
              const v = parse();
              v.values.regions[0].cents++;
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
  let app: Awaited<ReturnType<typeof observedSpecialistRouting>> | undefined;
  const open = async () =>
    (app = await observedSpecialistRouting(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(runSpecialistRoutingLoop, [input, options], {
      concurrency: 1,
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
          "scripts/fixtures/specialist-routing-child.ts",
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
      if (name === "cancel-after-execute")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "deadline",
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "sales-unavailable",
          "sales-changed",
          "code-changed",
          "request-changed",
          "source-changed",
          "permission-revoked",
          "route-tampered",
          "cross-role",
        ].includes(name)
      ) {
        await run({ stopAfter: "route" });
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          for (const role of ["router", ...roles] as const)
            await app!.storage.redis.pExpire(
              (config.context.cache?.keyPrefix ?? "ditto:context:") +
                contextScopeKey(scope(r, role)),
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
        if (name === "memory-unavailable" || name === "sales-unavailable") {
          const table = name === "memory-unavailable" ? "memories" : "sales",
            db = new DatabaseSync(
              join(
                dir,
                name === "memory-unavailable"
                  ? "memory.sqlite"
                  : "sales.sqlite",
              ),
            );
          try {
            db.exec(`ALTER TABLE ${table} RENAME TO unavailable`);
            await assert.rejects(run());
          } finally {
            db.exec(`ALTER TABLE unavailable RENAME TO ${table}`);
            db.close();
          }
        }
        if (name === "sales-changed") {
          const db = new DatabaseSync(join(dir, "sales.sqlite"));
          try {
            db.exec("UPDATE sales SET cents=1 WHERE id='S1'");
            await assert.rejects(run());
          } finally {
            db.exec("UPDATE sales SET cents=120000 WHERE id='S1'");
            db.close();
          }
        }
        if (name === "cross-role") {
          const raw = await readFile(join(dir, "route.json"), "utf8");
          const { createHash } = await import("node:crypto");
          const routeId = createHash("sha256").update(raw).digest("hex");
          await assert.rejects(
            app!.runtime.run(
              graph("cross-role-probe").node(
                "result",
                "INTERACTION.ACT.TOOL",
                [],
                () => ({
                  call: {
                    id: "read",
                    name: "routing_read",
                    arguments: json({ routeId, role: "finance" }),
                  },
                }),
              ),
              {},
            ),
          );
        }
        if (
          [
            "request-changed",
            "source-changed",
            "permission-revoked",
            "route-tampered",
            "code-changed",
          ].includes(name)
        ) {
          const path = join(
              dir,
              name === "request-changed"
                ? "request.json"
                : name === "source-changed"
                  ? "sources.json"
                  : name === "permission-revoked"
                    ? "policy.json"
                    : name === "route-tampered"
                      ? "route.json"
                      : "input-code/discount.mjs",
            ),
            old = await readFile(path, "utf8");
          if (name === "code-changed" || name === "route-tampered")
            await writeFile(path, old + " ");
          else {
            const v = JSON.parse(old);
            if (name === "request-changed") v.question += " changed";
            else if (name === "source-changed") v.finance.mealCents++;
            else v.enabled = false;
            await writeFile(path, JSON.stringify(v));
          }
          await assert.rejects(run());
          await writeFile(path, old);
        }
      }
      if (name === "artifact-tampered") {
        await run({ stopAfter: "operation" });
        const path = join(dir, "sales.csv"),
          old = await readFile(path, "utf8");
        await writeFile(path, old + "forged");
        const n = intervals.length;
        await assert.rejects(run());
        assert.equal(intervals.length, n);
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
    const clarification = [
        "ambiguous",
        "unsupported",
        "low-confidence",
        "semantic-mismatch",
      ].includes(name),
      invalidRoute = [
        "invalid-route",
        "unknown-role",
        "intent-mismatch",
      ].includes(name),
      invalidPlan = [
        "wrong-specialist",
        "wrong-action",
        "forged-citation",
      ].includes(name),
      invalidAnswer = name === "wrong-answer",
      limited = ["max-model-calls", "deadline"].includes(name);
    assert.equal(
      result.status,
      clarification
        ? "needs-clarification"
        : invalidRoute || invalidPlan || invalidAnswer || name === "role-denied"
          ? "needs-human"
          : limited
            ? "partial"
            : "completed",
    );
    assert.equal(
      result.stopReason,
      name === "semantic-mismatch"
        ? "specialist-route-mismatch"
        : clarification
          ? "needs-clarification"
          : invalidRoute
            ? "route-attempts-exhausted"
            : invalidPlan
              ? "specialist-attempts-exhausted"
              : invalidAnswer
                ? "answer-attempts-exhausted"
                : name === "role-denied"
                  ? "unavailable"
                  : limited
                    ? name
                    : "completed",
    );
    await app!.adapters.verify(result);
    if (clarification || invalidRoute || name === "role-denied") {
      if (name !== "semantic-mismatch")
        assert.ok(intervals.every((x) => x.agent === "router"));
      await assert.rejects(access(join(dir, "receipt.json")));
      assert.equal(result.answer, null);
    }
    const expected = (
      name === "semantic-mismatch"
        ? "finance"
        : roles.includes(scenario as Specialist)
          ? scenario
          : "data"
    ) as Specialist;
    assert.ok(
      intervals.every((x) => x.agent === "router" || x.agent === expected),
    );
    if (result.status === "completed") {
      assert.equal(result.route!.selected, expected);
      assert.equal(result.answer!.role, expected);
      const v = result.answer!.values;
      if (expected === "finance")
        assert.deepEqual(v, {
          submittedCents: 70000,
          approvedCents: 62000,
          excessCents: 8000,
        });
      else if (expected === "legal")
        assert.deepEqual(v, { noticeCompliant: true, dataReturnMissing: true });
      else if (expected === "data") {
        assert.equal(v.paidOrders, 3);
        assert.equal(v.revenueCents, 240000);
        assert.ok(
          (await readFile(join(dir, "sales.csv"), "utf8")).includes(
            "north,2,160000",
          ),
        );
      } else if (expected === "coding") {
        assert.equal(v.patchedPassed, 3);
        assert.ok(
          (await readFile(join(dir, "baseline-tests.txt"), "utf8")).includes(
            "# fail 2",
          ),
        );
        assert.ok(
          (await readFile(join(dir, "patched-tests.txt"), "utf8")).includes(
            "# pass 3",
          ),
        );
      }
    }
    if (roles.includes(name as Specialist)) {
      assert.deepEqual(
        intervals.map((x) => x.phase),
        ["route", "specialist", "answer"],
      );
      for (let i = 1; i < intervals.length; i++)
        assert.ok(intervals[i]!.start >= intervals[i - 1]!.end);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8");
    for (const c of result.answer?.citations ?? [])
      assert.ok(md.includes(c.quote));
    const before = intervals.length;
    assert.deepEqual(await runSpecialistRouting(app!.runtime, input), result);
    assert.equal(intervals.length, before);
    const calls = before + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      selected: result.route?.selected ?? null,
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
              context: "Redis per role",
              memory: "SQLite",
              business:
                "SQLite sales, bounded code patch/test artifacts and domain reports",
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
