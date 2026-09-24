import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { ResultTools } from "../examples/_shared/tools/observation/tools.ts";
import {
  modes,
  scenarios,
  verifyObservation,
  type Mode,
  type Scenario,
} from "../examples/_shared/tools/observation/domain.ts";
import { createFixture } from "../examples/_shared/tools/observation/service.ts";
import { sandbox } from "../examples/capabilities/observation/cli.ts";
import {
  runObservation,
  scope,
  memoryKey,
  type Options,
  type Report,
} from "../examples/capabilities/observation/shared.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    report: {
      type: "string",
      default: ".examples-observation-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-observation-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model;
assert.ok(model);
const cases: { name: string; mode: Mode; scenario?: Scenario }[] = [
  ...modes.map((mode) => ({ name: `${mode}-complete`, mode })),
  ...modes.map((mode) => ({ name: `${mode}-cache-expiry`, mode })),
  ...scenarios.map((scenario) => ({
    name: `outcome-${scenario}`,
    mode:
      scenario === "malformed"
        ? ("normalize" as const)
        : ("interpret" as const),
    scenario,
  })),
  ...[
    "redis-unavailable",
    "memory-unavailable",
    "state-db-unavailable",
    "cancel-before-work",
    "publication-retry",
    "model-wrong-total",
    "model-wrong-action",
    "input-changed",
    "observed-process-crash",
    "decision-process-crash",
    "state-effect-crash",
  ].map((name) => ({ name, mode: "read" as const })),
  { name: "retry-effect-crash", mode: "errors" },
];
limitCapabilityCases(cases);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  startedAt = new Date().toISOString(),
  results: Record<string, unknown>[] = [];
for (const item of cases) {
  console.log(JSON.stringify({ name: item.name, event: "started" }));
  const dir = join(directory, item.name);
  await mkdir(dir);
  const fixture = await createFixture(dir, item.mode, item.scenario),
    r = fixture.request;
  const spans: { node: string; input: unknown }[] = [],
    children: { spans: string[]; modelCalls: number }[] = [];
  let corrupt: string | undefined;
  function observed(d: WorkerDefinition): WorkerDefinition {
    return {
      ...d,
      instantiate() {
        const w = d.instantiate();
        return {
          async execute(node, input, context) {
            spans.push({ node, input });
            let value = await w.execute(node, input, context);
            if (corrupt && node === "INFER.REASONING.SAMPLE") {
              const modified = structuredClone(value) as {
                output: { message: { content: string } };
              };
              const decision = JSON.parse(
                modified.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (corrupt === "total") decision.totalCents = 999999;
              else decision.nextAction = "retry";
              modified.output.message.content = JSON.stringify(decision);
              value = modified;
            }
            return value;
          },
          async dispose() {
            await w.dispose?.();
          },
        };
      },
    };
  }
  let storage = await openAgentStorage(dir, config),
    adapters = new ResultTools(dir, r);
  const open = () =>
    createDitto({
      config,
      sandbox: sandbox(config, r),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: adapters.tools }),
      ].map(observed),
    });
  let runtime = open();
  const entry = await import(`../examples/capabilities/observation/${r.mode}.ts`) as { run: typeof runObservation };
  const run = (options: Options = {}): ReturnType<typeof runObservation> =>
    entry.run(
      runtime,
      { request: r, model: { provider, model } },
      options,
    );
  const reopen = async () => {
    await runtime.close();
    await storage.close();
    adapters.close();
    storage = await openAgentStorage(dir, config);
    adapters = new ResultTools(dir, r);
    runtime = open();
  };
  const calls = () =>
    spans.filter((s) => s.node === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () =>
    assert.equal(
      await readFile(join(dir, "artifacts/result.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  async function expire() {
    const key =
      (config.context.cache?.keyPrefix ?? "ditto:context:") +
      contextScopeKey(scope(r));
    await storage.redis.pExpire(key, 1);
    await delay(20);
    assert.equal(await storage.redis.get(key), null);
  }
  async function child(phase: string) {
    await new Promise<void>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/observation-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
          "--provider",
          provider!,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      p.stderr.on("data", (c) => {
        stderr += String(c);
      });
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(stderr || "Expected SIGKILL"))
          : code === 0
            ? done()
            : reject(new Error(stderr)),
      );
    });
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  const record: Record<string, unknown> = {
    name: item.name,
    mode: r.mode,
    scenario: r.scenario,
    status: "failed",
    directory: dir,
  };
  try {
    if (item.name.endsWith("cache-expiry")) {
      await run({ stopAfter: "decision" });
      await expire();
      await reopen();
    }
    switch (item.name) {
      case "redis-unavailable":
        await storage.redis.quit();
        await assert.rejects(run());
        assert.equal(calls(), 0);
        assert.equal(
          fixture.service.db
            .prepare("SELECT COUNT(*) AS n FROM requests")
            .get()!.n,
          0,
        );
        await reopen();
        break;
      case "memory-unavailable": {
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          db.exec("ALTER TABLE memories RENAME TO missing_memories");
          await assert.rejects(run());
          assert.equal(calls(), 0);
          db.exec("ALTER TABLE missing_memories RENAME TO memories");
        } finally {
          db.close();
        }
        await reopen();
        break;
      }
      case "state-db-unavailable":
        adapters.db.exec("ALTER TABLE events RENAME TO missing_events");
        await assert.rejects(run());
        await absent();
        adapters.db.exec("ALTER TABLE missing_events RENAME TO events");
        await reopen();
        break;
      case "cancel-before-work":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        break;
      case "publication-retry":
        await writeFile(join(dir, "artifacts"), "occupied");
        await assert.rejects(run());
        await rm(join(dir, "artifacts"));
        await reopen();
        break;
      case "model-wrong-total":
      case "model-wrong-action":
        corrupt = item.name.endsWith("total") ? "total" : "action";
        await assert.rejects(run(), /contradicts evidence/);
        await absent();
        assert.equal(
          adapters.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n,
          0,
        );
        corrupt = undefined;
        break;
      case "input-changed":
        await run({ stopAfter: "decision" });
        await assert.rejects(
          runObservation(runtime, {
            request: { ...r, orderId: "ORD-CHANGED" },
            model: { provider, model },
          }),
          /Request changed/,
        );
        break;
      case "observed-process-crash":
        await child("observed-crash");
        await absent();
        await expire();
        await child("continue");
        break;
      case "decision-process-crash":
        await child("decision-crash");
        await absent();
        await expire();
        await child("continue");
        break;
      case "state-effect-crash":
      case "retry-effect-crash":
        await child(item.name);
        await absent();
        await expire();
        await child("continue");
        break;
    }
    const result = (await run()) as Report;
    const terminal = ["success", "transient", "timeout", "disconnect"].includes(
      r.scenario,
    )
      ? "completed"
      : r.scenario === "cancelled"
        ? "stopped"
        : "needs_review";
    assert.equal(result.state, terminal);
    assert.equal(result.verified, true);
    const rounds = [
      "transient",
      "timeout",
      "disconnect",
      "persistent-transient",
    ].includes(r.scenario)
      ? 2
      : 1;
    assert.equal(result.rounds.length, rounds);
    assert.equal(
      calls(),
      rounds + (item.name.startsWith("model-wrong-") ? 1 : 0),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "artifacts/result.json"), "utf8")),
      result,
    );
    const job = fixture.service.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(r.orderId)!;
    const expectedKinds: Record<Scenario, string> = {
      success: "none",
      transient: "transient",
      denied: "permission",
      "not-found": "not_found",
      timeout: "timeout",
      disconnect: "transport",
      malformed: "invalid_output",
      "business-failure": "business",
      cancelled: "cancelled",
      "persistent-transient": "transient",
    };
    assert.equal(
      result.rounds[0]!.decision.errorKind,
      expectedKinds[r.scenario],
    );
    for (const entry of result.rounds)
      verifyObservation(entry.result, entry.observation);
    if (terminal === "completed") {
      assert.equal(
        result.rounds.at(-1)!.decision.totalCents,
        Number(job.quantity) * Number(job.unit_cents),
      );
      assert.equal(job.status, "completed");
    }
    assert.equal(
      job.retries,
      ["transient", "persistent-transient"].includes(r.scenario) ? 1 : 0,
    );
    const paths = fixture.service.db
      .prepare("SELECT path FROM requests")
      .all()
      .map((row) => row.path);
    if (["timeout", "disconnect"].includes(r.scenario)) {
      assert.ok(paths.includes("/status"));
      assert.ok(!paths.includes("/retry"));
    }
    assert.deepEqual(
      {
        ...adapters.db
          .prepare("SELECT state,version FROM task WHERE id=?")
          .get(r.id),
      },
      { state: terminal, version: rounds },
    );
    assert.equal(
      adapters.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n,
      rounds,
    );
    const before = calls(),
      requests = paths.length;
    await expire();
    await reopen();
    assert.deepEqual(await run(), result);
    assert.equal(calls(), before);
    assert.equal(
      fixture.service.db.prepare("SELECT COUNT(*) AS n FROM requests").get()!.n,
      requests,
    );
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
    try {
      assert.ok(
        db
          .prepare("SELECT content FROM memories WHERE memory_key=?")
          .get(memoryKey(r, "report")),
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM memories").get()!.n,
        2 + 2 * rounds,
      );
    } finally {
      db.close();
    }
    const allNodes = [
      ...spans.map((s) => s.node),
      ...children.flatMap((c) => c.spans),
    ];
    for (const node of [
      "MEMORY.GET",
      "MEMORY.WRITE",
      "CONTEXT.LOAD",
      "CONTEXT.UPDATE",
      "INFER.REASONING.SAMPLE",
      "INTERACTION.ACT.TOOL",
      "INTERACTION.OBSERVE",
    ])
      assert.ok(allNodes.includes(node));
    Object.assign(record, {
      status: "passed",
      taskState: result.state,
      rounds: result.rounds,
      remoteRequests: paths,
    });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    await runtime.close();
    await storage.close();
    adapters.close();
    await fixture.service.close();
    Object.assign(record, { spans, children, modelCalls: calls() });
    results.push(record);
    await writeFile(
      resolve(values.report!),
      JSON.stringify(
        {
          startedAt,
          provider,
          model,
          directory,
          targets:
            "HTTP result service + remote SQLite + task SQLite + Memory SQLite + Redis",
          results,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        name: item.name,
        status: record.status,
        modelCalls: calls(),
        ...(record.error ? { error: record.error } : {}),
      }),
    );
  }
}
const failed = results.filter((r) => r.status !== "passed");
console.log(
  JSON.stringify(
    {
      passed: results.length - failed.length,
      total: results.length,
      modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0),
      report: resolve(values.report!),
    },
    null,
    2,
  ),
);
if (failed.length)
  throw new Error(`${failed.length} observation task experiments failed`);
