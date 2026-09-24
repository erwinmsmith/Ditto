import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
} from "../examples/_shared/tools/handoff/adapters.ts";
import {
  roles,
  type Report,
  type Agent,
} from "../examples/_shared/tools/handoff/domain.ts";
import {
  runHandoff,
  runHandoffLoop,
  scope,
  type Options,
} from "../examples/patterns/handoff/index.ts";
import { json } from "../examples/_shared/tools/evidence.ts";
import { openHandoff } from "../examples/patterns/handoff/cli.ts";
import { observedHandoff } from "./fixtures/handoff-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-handoff-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-handoff-tasks" },
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
  "replacement",
  "resolved",
  "missing-diagnostic",
  "out-of-warranty",
  "role-models",
  "owner-retry",
  "receiver-retry",
  "receiver-refuses",
  "wrong-recipient",
  "foreign-packet",
  "route-skip",
  "forged-citation",
  "old-owner",
  "early-receiver",
  "duplicate-acceptance",
  "concurrent-acceptance",
  "max-transfers",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "business-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "packet-tampered",
  "cancelled",
  "cancel-after-accept",
  "effect-crash",
  "accept-crash",
  "completion-crash",
  "completion-rollback",
  "sample-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    scenario = (
      ["resolved", "missing-diagnostic", "out-of-warranty"].includes(name)
        ? name
        : "replacement"
    ) as Scenario;
  const r = await createDemo(
    dir,
    {
      maxTransfers: name === "max-transfers" ? 1 : 4,
      maxModelCalls: name === "max-model-calls" ? 1 : 12,
      deadlineSeconds: name === "deadline" ? 1 : 600,
    },
    scenario,
  );
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    intervals: { agent: Agent; phase: string; start: number; end: number }[] =
      [],
    controller = new AbortController();
  let injected = 0;
  let pausedAcceptance: Record<string, unknown> | undefined;
  const modelConfig = { provider: provider!, model: model! },
    input = {
      request: r,
      model: modelConfig,
      ...(name === "role-models"
        ? { models: Object.fromEntries(roles.map((a) => [a, modelConfig])) }
        : {}),
    };
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, args, context) {
          if (
            name === "concurrent-acceptance" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(args).includes('"handoff_accept"')
          ) {
            injected++;
            pausedAcceptance = (
              args as { call: { arguments: Record<string, unknown> } }
            ).call.arguments;
            throw new Error("pause-before-accept");
          }
          spans.push(node);
          const start = Date.now(),
            out = await w.execute(node, args, context);
          if (
            name === "cancel-after-accept" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(args).includes('"handoff_accept"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            const messages = (args as { messages: { content: string }[] })
                .messages,
              data = JSON.parse(messages.at(-1)!.content),
              role: Agent = data.role;
            intervals.push({
              agent: role,
              phase: data.phase,
              start,
              end: Date.now(),
            });
            await writeFile(
              join(dir, `model-${intervals.length}.json`),
              JSON.stringify({ input: args, output: out }, null, 2),
            );
            assert.ok(
              !JSON.stringify(args).includes("customer@example.invalid"),
            );
            if (data.phase === "decide") {
              assert.equal(data.evidence.agent, role);
              if (role === "customer-service") {
                assert.equal(data.parent, null);
                assert.ok(
                  !JSON.stringify(data.evidence).includes("Diagnostic record"),
                );
              } else {
                assert.equal(data.parent.to, role);
                assert.equal(data.parent.acceptance.accepted, true);
              }
            } else {
              assert.equal(data.packet.to, role);
              assert.equal(
                data.packet.from,
                role === "technical-support"
                  ? "customer-service"
                  : "technical-support",
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
              (name === "owner-retry" &&
                data.phase === "decide" &&
                !injected) ||
              (name === "receiver-retry" &&
                data.phase === "accept" &&
                !injected)
            ) {
              changed.output.message.content = "invalid injected result";
              injected++;
              return changed;
            }
            if (
              [
                "receiver-refuses",
                "wrong-recipient",
                "foreign-packet",
              ].includes(name) &&
              data.phase === "accept"
            ) {
              const v = parse();
              if (name === "receiver-refuses") v.accepted = false;
              else if (name === "wrong-recipient") v.agent = "after-sales";
              else v.packetId = "f".repeat(64);
              changed.output.message.content = JSON.stringify(v);
              injected++;
              return changed;
            }
            if (
              ["route-skip", "forged-citation"].includes(name) &&
              role === "customer-service"
            ) {
              const v = parse();
              if (name === "route-skip") v.to = "after-sales";
              else v.citations[0].quote = "forged";
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
  let app: Awaited<ReturnType<typeof observedHandoff>> | undefined;
  const open = async () =>
    (app = await observedHandoff(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(runHandoffLoop, [input, options], {
      concurrency: 1,
      ...(options.signal ? { signal: options.signal } : {}),
      onGraph: (e) => {
        if (e.status === "started") graphs.push(e.graphId);
      },
    });
  const tool = async (name: string, args: object) =>
    (
      await app!.runtime.run(
        graph("handoff-boundary-probe").node(
          "result",
          "INTERACTION.ACT.TOOL",
          [],
          () => ({ call: { id: name, name, arguments: json(args) } }),
        ),
        {},
      )
    ).result;
  async function child(phase: string) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/handoff-child.ts",
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
      if (name === "cancel-after-accept")
        await assert.rejects(run({ signal: controller.signal }));
      if (
        [
          "deadline",
          "redis-expiry",
          "redis-unavailable",
          "memory-unavailable",
          "business-unavailable",
          "request-changed",
          "source-changed",
          "permission-revoked",
          "packet-tampered",
          "early-receiver",
        ].includes(name)
      ) {
        await run({ stopAfter: "proposal" });
        const before = await app!.adapters.snapshot();
        assert.equal(before.owner, "customer-service");
        assert.equal(before.version, 0);
        assert.ok(before.pending);
        if (name === "early-receiver") {
          await assert.rejects(
            tool("handoff_read", { agent: "technical-support", version: 0 }),
          );
          assert.deepEqual(await app!.adapters.snapshot(), before);
        }
        if (name === "deadline") await delay(1100);
        if (name === "redis-expiry") {
          for (const role of roles)
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
        if (name === "memory-unavailable" || name === "business-unavailable") {
          const db = new DatabaseSync(
              join(
                dir,
                name === "memory-unavailable"
                  ? "memory.sqlite"
                  : "tickets.sqlite",
              ),
            ),
            table = name === "memory-unavailable" ? "memories" : "ticket";
          try {
            db.exec(`ALTER TABLE ${table} RENAME TO unavailable`);
            const n = intervals.length;
            await assert.rejects(run());
            assert.equal(intervals.length, n);
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
                  ? "sources.json"
                  : "policy.json",
            ),
            old = await readFile(path, "utf8"),
            v = JSON.parse(old);
          if (name === "request-changed") v.goal += " changed";
          else if (name === "source-changed") v.diagnostic = "resolved";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          const n = intervals.length;
          await assert.rejects(run());
          assert.equal(intervals.length, n);
          await writeFile(path, old);
        }
        if (name === "packet-tampered") {
          const db = new DatabaseSync(join(dir, "tickets.sqlite")),
            old = String(db.prepare("SELECT state FROM ticket").get()!.state),
            t = JSON.parse(old);
          try {
            t.pending.packet.decision.summary += " changed";
            db.prepare("UPDATE ticket SET state=?").run(JSON.stringify(t));
            const n = intervals.length;
            await assert.rejects(run());
            assert.equal(intervals.length, n);
          } finally {
            db.prepare("UPDATE ticket SET state=?").run(old);
            db.close();
          }
        }
      }
      if (name === "concurrent-acceptance") {
        await assert.rejects(run(), /pause-before-accept/);
        assert.ok(pausedAcceptance);
        const before = await app!.adapters.snapshot();
        assert.equal(before.owner, "customer-service");
        assert.ok(before.pending);
        const second = await openHandoff(dir, r, config);
        try {
          const args = pausedAcceptance;
          await Promise.all([
            tool("handoff_accept", args),
            second.runtime.run(
              graph("independent-acceptance").node(
                "result",
                "INTERACTION.ACT.TOOL",
                [],
                () => ({
                  call: {
                    id: "accept",
                    name: "handoff_accept",
                    arguments: json(args),
                  },
                }),
              ),
              {},
            ),
          ]);
        } finally {
          await second.close();
        }
        const after = await app!.adapters.snapshot();
        assert.equal(after.owner, "technical-support");
        assert.equal(after.history.length, 1);
        assert.equal(after.version, 1);
      }
      if (["old-owner", "duplicate-acceptance"].includes(name)) {
        await run({ stopAfter: "acceptance" });
        const t = await app!.adapters.snapshot(),
          h = t.history[0]!;
        assert.equal(t.owner, "technical-support");
        assert.equal(t.version, 1);
        assert.equal(t.pending, null);
        if (name === "old-owner") {
          await assert.rejects(
            tool("handoff_read", { agent: "customer-service", version: 0 }),
          );
          await assert.rejects(
            tool("handoff_decide", {
              agent: "customer-service",
              version: 0,
              decision: h.decision,
            }),
          );
        } else {
          const args = {
            agent: "technical-support",
            version: 0,
            packetId: h.packetId,
            acceptance: h.acceptance,
          };
          await tool("handoff_accept", args);
          assert.deepEqual(await app!.adapters.snapshot(), t);
          await assert.rejects(
            tool("handoff_accept", {
              ...args,
              acceptance: { ...h.acceptance, summary: "changed replay" },
            }),
          );
        }
      }
      if (name === "completion-rollback") {
        const db = new DatabaseSync(join(dir, "tickets.sqlite"));
        try {
          db.exec(
            "CREATE TRIGGER reject_completion BEFORE UPDATE ON ticket WHEN json_extract(NEW.state, '$.resolution') = 'replacement-requested' BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END",
          );
          await assert.rejects(run());
          assert.equal(
            Number(
              db.prepare("SELECT count(*) AS n FROM replacements").get()!.n,
            ),
            0,
          );
          const state = await app!.adapters.snapshot();
          assert.equal(state.owner, "after-sales");
          assert.equal(state.status, "active");
          db.exec("DROP TRIGGER reject_completion");
        } finally {
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
    const failed = [
        "receiver-refuses",
        "wrong-recipient",
        "foreign-packet",
        "route-skip",
        "forged-citation",
      ].includes(name),
      human = ["missing-diagnostic", "out-of-warranty"].includes(name),
      limited = ["max-transfers", "max-model-calls", "deadline"].includes(name);
    assert.equal(
      result.status,
      failed || human ? "needs-human" : limited ? "partial" : "completed",
    );
    assert.equal(
      result.stopReason,
      failed
        ? "agent-attempts-exhausted"
        : human
          ? "owner-escalated"
          : limited
            ? name
            : "completed",
    );
    await app!.adapters.verify(result);
    const t = result.ticket;
    if (failed) {
      assert.equal(t.owner, "customer-service");
      assert.equal(t.version, 0);
      assert.equal(t.history.length, 0);
      assert.equal(
        !!t.pending,
        !["route-skip", "forged-citation"].includes(name),
      );
    }
    if (result.status === "completed") {
      assert.equal(
        t.resolution,
        name === "resolved" ? "resolved" : "replacement-requested",
      );
      assert.equal(
        t.owner,
        name === "resolved" ? "technical-support" : "after-sales",
      );
    }
    if (name === "replacement") {
      assert.deepEqual(
        intervals.map((x) => `${x.agent}:${x.phase}`),
        [
          "customer-service:decide",
          "technical-support:accept",
          "technical-support:decide",
          "after-sales:accept",
          "after-sales:decide",
        ],
      );
      for (let i = 1; i < intervals.length; i++)
        assert.ok(intervals[i]!.start >= intervals[i - 1]!.end);
      assert.equal(t.history.length, 3);
      assert.equal(t.history[1]!.from, "technical-support");
      assert.equal(t.history[1]!.acceptance!.agent, "after-sales");
    }
    if (name === "resolved" || name === "missing-diagnostic")
      assert.ok(intervals.every((x) => x.agent !== "after-sales"));
    const db = new DatabaseSync(join(dir, "tickets.sqlite"));
    try {
      assert.equal(
        Number(db.prepare("SELECT count(*) AS n FROM replacements").get()!.n),
        t.resolution === "replacement-requested" ? 1 : 0,
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const md = await readFile(join(dir, "output/report.md"), "utf8");
    for (const h of t.history)
      for (const c of h.decision.citations) assert.ok(md.includes(c.quote));
    assert.ok(!md.includes("customer@example.invalid"));
    const before = intervals.length;
    assert.deepEqual(await runHandoff(app!.runtime, input), result);
    assert.equal(intervals.length, before);
    const calls = before + children.reduce((n, c) => n + c.modelCalls, 0);
    assert.ok(calls <= result.usage.modelCalls);
    assert.ok(result.usage.modelCalls <= r.maxModelCalls);
    return {
      name,
      status: "passed",
      taskStatus: result.status,
      stopReason: result.stopReason,
      owner: t.owner,
      transfers: t.history.filter((h) => h.kind === "transfer").length,
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
                "SQLite ticket ownership, acknowledged handoffs and replacement requests",
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
