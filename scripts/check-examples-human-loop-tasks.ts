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
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { contextScopeKey } from "@ditto/core/worker/context";
import type { WorkerDefinition } from "@ditto/core/worker";
import {
  createDemo,
  type Result,
} from "../examples/_shared/tools/human-loop/adapters.ts";
import {
  runHumanLoop,
  runHumanLoopPlan,
  scope,
  type Options,
} from "../examples/patterns/human-in-the-loop/index.ts";
import { observedHumanLoop } from "./fixtures/human-loop-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-human-loop-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-human-loop-tasks" },
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
  "pending",
  "approve-during-delivery",
  "model-unavailable",
  "approve",
  "edit-approve",
  "reject",
  "conflicting-sources",
  "claim-handoff",
  "invalid-draft",
  "invalid-continuation",
  "unauthorized-reviewer",
  "stale-approval",
  "edit-after-approval",
  "edit-during-continuation",
  "permission-revoked",
  "reviewer-revoked",
  "request-changed",
  "source-changed",
  "draft-tampered",
  "publication-tampered",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "delivery-failure",
  "cancelled",
  "cancel-after-effect",
  "draft-crash",
  "review-crash",
  "generate-crash",
  "effect-crash",
  "partial-publication",
  "max-model-calls",
  "deadline",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    r = await createDemo(
      dir,
      {
        maxModelCalls: name === "max-model-calls" ? 1 : 4,
        deadlineSeconds: name === "deadline" ? 1 : 600,
      },
      ["conflicting-sources", "claim-handoff"].includes(name),
    );
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [],
    controller = new AbortController();
  let injected = 0;
  let app: Awaited<ReturnType<typeof observedHumanLoop>> | undefined;
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const out = await w.execute(node, input, context);
          if (
            name === "approve-during-delivery" &&
            node === "INTERACTION.OUTPUT" &&
            !injected
          ) {
            injected++;
            await approval();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            if (name === "model-unavailable" && !injected) {
              injected++;
              return {
                executionId: "injected",
                node,
                status: "failed",
                error: {
                  code: "EXECUTION_FAILED",
                  message: "Injected model transport failure",
                },
              };
            }

            await writeFile(
              join(dir, `model-${spans.filter((n) => n === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            const continuing = JSON.stringify(input).includes(
              "Prepare the human-approved publication",
            );
            if (
              (name === "invalid-draft" && !continuing) ||
              (name === "invalid-continuation" && continuing)
            ) {
              injected++;
              const changed = structuredClone(out) as {
                output: { message: { content: string } };
              };
              changed.output.message.content = "not JSON";
              return changed;
            }
            if (
              name === "edit-during-continuation" &&
              continuing &&
              !injected
            ) {
              injected++;
              await edit();
            }
          }
          if (
            name === "cancel-after-effect" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"human_apply"')
          ) {
            injected++;
            controller.abort();
          }
          return out;
        },
        async dispose() {
          await w.dispose?.();
        },
      };
    },
  });
  const open = async () =>
    (app = await observedHumanLoop(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(
      runHumanLoopPlan,
      [{ request: r, model: { provider: provider!, model: model! } }, options],
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onGraph: (e) => {
          if (e.status === "started") graphs.push(e.graphId);
        },
      },
    );
  const noPublication = () =>
    assert.rejects(access(join(dir, "published", r.id + ".json")));
  const approval = (
    actor = "example-publisher",
    choice: "approve" | "reject" = "approve",
  ) => {
    const gate = app!.adapters.state().request!;
    return app!.adapters.decide({
      requestId: gate.id,
      expectedToken: gate.token,
      actor,
      choice,
    });
  };
  const edit = () => {
    const s = app!.adapters.state();
    return app!.adapters.edit({
      requestId: s.request!.id,
      expectedToken: s.request!.token,
      actor: "example-publisher",
      replacement: {
        ...s.artifact!.draft,
        title: "Human edited release",
        date: "2026-12-18",
        body:
          s.artifact!.draft.body +
          "\nHuman-approved rollout window: December 18.",
      },
      note: "Move the release and clarify rollout",
    });
  };
  async function child(phase: string) {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/human-loop-child.ts",
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
    if (["draft-crash", "review-crash", "generate-crash"].includes(name)) {
      await child(name);
      await child("continue");
    }
    await open();
    assert.ok(
      app!.adapters.tools.every(
        (t) => !/(decide|approve|edit|claim)/.test(t.name),
      ),
    );
    if (name === "cancelled") {
      controller.abort();
      await assert.rejects(run({ signal: controller.signal }));
      assert.equal(spans.length, 0);
    }
    if (name === "delivery-failure") {
      await run({ stopAfter: "draft" });
      await mkdir(join(dir, "inbox"));
      await writeFile(join(dir, "inbox-block"), "blocked");
      await rm(join(dir, "inbox"), { recursive: true });
      await writeFile(join(dir, "inbox"), "not a directory");
      await assert.rejects(run());
      const gate = app!.adapters.state().request!;
      assert.equal(gate.delivered, false);
      await assert.rejects(approval());
      await noPublication();
      await rm(join(dir, "inbox"));
    }
    if (name === "model-unavailable") {
      await assert.rejects(run());
      await noPublication();
    }
    let result = (await run()) as Result;
    if (
      ["conflicting-sources", "claim-handoff", "invalid-draft"].includes(name)
    ) {
      assert.equal(result.status, "escalated");
      await assert.rejects(approval());
      if (name === "claim-handoff") {
        const gate = result.state.request!;
        await app!.adapters.claim({
          requestId: gate.id,
          expectedToken: gate.token,
          actor: "example-triager",
          note: "Investigate conflicting release dates",
        });
        result = (await run()) as Result;
        assert.equal(result.state.job.assignee, "example-triager");
      }
    } else if (name !== "approve-during-delivery") {
      assert.equal(result.status, "awaiting-human");
      assert.equal(result.state.request!.delivered, true);
      await noPublication();
      assert.equal(
        app!.adapters.store.db
          .prepare("SELECT count(*) AS n FROM effects")
          .get()!.n,
        0,
      );
      const gate = result.state.request!,
        envelope = JSON.parse(
          await readFile(join(dir, "inbox", gate.id + ".json"), "utf8"),
        );
      assert.deepEqual(envelope.snapshot, gate.snapshot);
      assert.equal(envelope.token, gate.token);
      const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
      assert.deepEqual(await run(), result);
      assert.equal(
        spans.filter((n) => n === "INFER.REASONING.SAMPLE").length,
        before,
      );
      if (name !== "pending") {
        if (name === "unauthorized-reviewer") {
          await assert.rejects(approval("intruder"));
          assert.equal(app!.adapters.state().job.stage, "awaiting-review");
          await noPublication();
        }
        if (["edit-approve", "stale-approval"].includes(name)) {
          await edit();
          await assert.rejects(
            app!.adapters.decide({
              requestId: gate.id,
              expectedToken: gate.token,
              actor: "example-publisher",
              choice: "approve",
            }),
          );
          result = (await run()) as Result;
          assert.equal(result.status, "awaiting-human");
          assert.notEqual(result.state.request!.token, gate.token);
          await noPublication();
        }
        if (name === "draft-tampered") {
          const db = app!.adapters.store.db,
            row = db
              .prepare("SELECT data FROM versions WHERE jobId=? AND version=1")
              .get(r.id)!,
            old = String(row.data),
            v = JSON.parse(old);
          v.draft.body += " altered";
          db.prepare(
            "UPDATE versions SET data=? WHERE jobId=? AND version=1",
          ).run(JSON.stringify(v), r.id);
          await assert.rejects(run());
          await noPublication();
          db.prepare(
            "UPDATE versions SET data=? WHERE jobId=? AND version=1",
          ).run(old, r.id);
        }
        if (name === "redis-expiry") {
          const key =
            (config.context.cache?.keyPrefix ?? "ditto:context:") +
            contextScopeKey(scope(r));
          assert.ok(await app!.storage.redis.get(key));
          await app!.storage.redis.pExpire(key, 1);
          await delay(10);
          assert.equal(await app!.storage.redis.get(key), null);
          result = (await run()) as Result;
          assert.ok(await app!.storage.redis.get(key));
          assert.equal(result.status, "awaiting-human");
        }
        if (name === "redis-unavailable") {
          await app!.storage.redis.quit();
          await assert.rejects(run());
          await noPublication();
          await app!.close();
          await open();
        }
        if (name === "memory-unavailable") {
          const db = new DatabaseSync(join(dir, "memory.sqlite"));
          try {
            db.exec("ALTER TABLE memories RENAME TO unavailable");
            await assert.rejects(run());
            await noPublication();
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
                  ? r.id + ".source.json"
                  : "policy.json",
            ),
            saved = await readFile(path, "utf8"),
            v = JSON.parse(saved);
          if (name === "request-changed") v.goal += " changed";
          else if (name === "source-changed") v.change += " changed";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await noPublication();
          await writeFile(path, saved);
        }
        await approval(
          "example-publisher",
          name === "reject" ? "reject" : "approve",
        );
        await assert.rejects(approval());
        if (name === "edit-after-approval") {
          await edit();
          result = (await run()) as Result;
          assert.equal(result.status, "awaiting-human");
          await noPublication();
          await approval();
        }
        if (name === "reviewer-revoked") {
          const path = join(dir, "policy.json"),
            saved = await readFile(path, "utf8"),
            v = JSON.parse(saved);
          v.reviewers["example-publisher"] = [];
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await noPublication();
          await writeFile(path, saved);
        }
        if (name === "deadline") await delay(1100);
        if (name === "effect-crash") {
          await app!.close();
          app = undefined;
          await child(name);
          await child("continue");
          await open();
        }
        if (name === "partial-publication") {
          await run({ stopAfter: "continued" });
          await mkdir(join(dir, "published"), { recursive: true });
          await writeFile(join(dir, "published", r.id + ".md"), "conflict");
          await assert.rejects(run());
          assert.equal(app!.adapters.state().job.stage, "executing");
          assert.equal(
            app!.adapters.store.db
              .prepare("SELECT count(*) AS n FROM effects")
              .get()!.n,
            1,
          );
          await access(join(dir, "published", r.id + ".json"));
          await rm(join(dir, "published", r.id + ".md"));
        }
        if (name === "cancel-after-effect")
          await assert.rejects(run({ signal: controller.signal }));
        result = (await run()) as Result;
        if (name === "edit-during-continuation") {
          assert.equal(result.status, "awaiting-human");
          await noPublication();
          await approval();
          result = (await run()) as Result;
          assert.equal(result.state.artifact!.version, 2);
        }
      }
    }
    const expected =
      name === "pending"
        ? "awaiting-human"
        : name === "reject"
          ? "rejected"
          : ["conflicting-sources", "claim-handoff", "invalid-draft"].includes(
                name,
              )
            ? "escalated"
            : ["max-model-calls", "deadline", "invalid-continuation"].includes(
                  name,
                )
              ? "partial"
              : "completed";
    assert.equal(result.status, expected);
    if (expected === "completed") {
      const saved = JSON.parse(
        await readFile(join(dir, "published", r.id + ".json"), "utf8"),
      );
      assert.deepEqual(saved.content, result.state.artifact!.draft);
      assert.equal(saved.reviewToken, result.state.request!.token);
      assert.equal(saved.digest, result.state.artifact!.digest);
      assert.equal(result.state.request!.actor, "example-publisher");
      assert.equal(
        app!.adapters.store.db
          .prepare("SELECT count(*) AS n FROM effects")
          .get()!.n,
        1,
      );
      assert.equal(
        app!.adapters.store.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE kind='effect-completed'",
          )
          .get()!.n,
        1,
      );
      if (
        [
          "edit-approve",
          "stale-approval",
          "edit-after-approval",
          "edit-during-continuation",
        ].includes(name)
      ) {
        assert.equal(saved.content.date, "2026-12-18");
        assert.equal(saved.content.title, "Human edited release");
      }
      if (name === "publication-tampered") {
        const path = join(dir, "published", r.id + ".md"),
          old = await readFile(path, "utf8");
        await writeFile(path, old + "tampered");
        await assert.rejects(run());
        await writeFile(path, old);
      }
    } else await noPublication();
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    assert.deepEqual(
      await runHumanLoop(app!.runtime, {
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
      reason: result.reason,
      modelCalls: calls,
      version: result.state.artifact?.version ?? 0,
      directory: dir,
      graphs: [...new Set(graphs)],
      humanDecisionSource: "explicit test controller",
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
              context: "Redis",
              memory: "SQLite",
              review:
                "separate SQLite review database and actual local publication files",
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
