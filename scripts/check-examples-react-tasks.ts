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
import { createTask } from "../examples/_shared/tools/react/adapters.ts";
import {
  createDemo,
  type Scenario,
} from "../examples/_shared/tools/react/service.ts";
import type { Report } from "../examples/_shared/tools/react/domain.ts";
import { digest } from "../examples/_shared/tools/evidence.ts";
import {
  runReact,
  runReactLoop,
  scope,
  type Options,
} from "../examples/patterns/react/index.ts";
import { observedReact } from "./fixtures/react-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-react-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-react-tasks" },
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
  "recover",
  "already-completed",
  "permanent",
  "persistent",
  "inspect",
  "disconnect",
  "timeout",
  "browser",
  "chinese",
  "hostile",
  "max-steps",
  "max-actions",
  "no-progress",
  "deadline",
  "invalid-tool",
  "invalid-arguments",
  "wrong-total",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "permission-revoked",
  "evidence-tampered",
  "cancelled",
  "cancel-after-effect",
  "effect-crash",
  "observation-0-0-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name);
  const scenario =
    (
      {
        permanent: "permanent",
        persistent: "persistent",
        disconnect: "disconnect",
        timeout: "timeout",
        hostile: "hostile",
        "already-completed": "completed",
      } as Record<string, Scenario>
    )[name] ?? "transient";
  const demo = await createDemo(dir, scenario, {
    delivery: name === "browser" ? "browser" : "api",
    mode: name === "inspect" ? "inspect" : "recover",
    ...(name === "chinese"
      ? {
          goal: "诊断导出任务失败原因；只有处理手册允许时才恢复任务。读取完成后的 CSV，核对以分计的总额；无法恢复则转人工。",
        }
      : {}),
    maxSteps: name === "max-steps" ? 1 : 12,
    maxActions: name === "max-actions" ? 0 : 12,
    maxRepeatedActions: name === "no-progress" ? 2 : 3,
    deadlineSeconds: name === "deadline" ? 1 : 600,
  });
  const r = await createTask(dir, demo.request),
    spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  let injected = 0;
  const cancellation = new AbortController();
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const out = await w.execute(node, input, context);
          if (
            name === "cancel-after-effect" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"job_retry"')
          ) {
            injected++;
            cancellation.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((n) => n === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            const changed = structuredClone(out) as {
              output: {
                actionRequests?: {
                  id: string;
                  name: string;
                  arguments: Record<string, unknown>;
                }[];
                finishReason: string;
                message: { role: "assistant"; content: string };
              };
            };
            if (name === "no-progress") {
              changed.output = {
                ...changed.output,
                finishReason: "action_request",
                message: {
                  ...changed.output.message,
                  role: "assistant",
                  content: "",
                },
                actionRequests: [
                  {
                    id:
                      changed.output.actionRequests?.[0]?.id ??
                      `call_repeat_${injected++}`,
                    name: "job_status",
                    arguments: { jobId: r.jobId },
                  },
                ],
              };
              return changed;
            }
            if (
              ["invalid-tool", "invalid-arguments"].includes(name) &&
              changed.output.actionRequests?.length
            ) {
              injected++;
              if (name === "invalid-tool")
                changed.output.actionRequests[0]!.name = "delete_database";
              else
                changed.output.actionRequests[0]!.arguments = {
                  jobId: "OUTSIDE-SCOPE",
                };
              return changed;
            }
            if (
              name === "wrong-total" &&
              !injected &&
              !changed.output.actionRequests?.length
            ) {
              let f: Record<string, unknown>;
              try {
                f = JSON.parse(
                  changed.output.message.content
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
              } catch {
                return out;
              }
              if (f.status === "completed") {
                f.totalCents = Number(f.totalCents) + 1;
                changed.output.message.content = JSON.stringify(f);
                injected++;
                return changed;
              }
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
  const open = () => observedReact(dir, r, config, observe);
  let app = await open();
  const calls = () =>
    spans.filter((n) => n === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
  const run = (options: Options = {}) =>
    app.runtime.loop(
      runReactLoop,
      [{ request: r, model: { provider: provider!, model: model! } }, options],
      {
        ...(options.signal ? { signal: options.signal } : {}),
        onGraph(e) {
          if (e.status === "started") graphs.push(e.graphId);
        },
      },
    );
  const reopen = async () => {
    await app.close();
    app = await open();
  };
  const absent = async () =>
    assert.equal(
      await readFile(join(dir, "output/report.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  const expire = async () => {
    const key =
      (config.context.cache?.keyPrefix ?? "ditto:context:") +
      contextScopeKey(scope(r));
    await app.storage.redis.pExpire(key, 1);
    await delay(10);
    assert.equal(await app.storage.redis.get(key), null);
  };
  async function child(phase: string) {
    await new Promise<void>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/react-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
          "--provider",
          provider!,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      p.stderr.on("data", (s) => (error += String(s)));
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("-crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(error || "Expected crash"))
          : code === 0
            ? done()
            : reject(new Error(error)),
      );
    });
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  const record: Record<string, unknown> = {
    name,
    status: "failed",
    directory: dir,
    transport:
      name === "browser"
        ? "real-chromium-local-service"
        : "real-http-local-service",
    faultInjection: [
      "no-progress",
      "invalid-tool",
      "invalid-arguments",
      "wrong-total",
    ].includes(name),
  };
  try {
    switch (name) {
      case "redis-expiry":
        await run({ stopAfter: "observation" });
        await expire();
        await reopen();
        break;
      case "redis-unavailable":
        await app.storage.redis.quit();
        await assert.rejects(run());
        assert.equal(calls(), 0);
        await reopen();
        break;
      case "memory-unavailable": {
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          db.exec("ALTER TABLE memories RENAME TO unavailable");
          await assert.rejects(run());
          assert.equal(calls(), 0);
          db.exec("ALTER TABLE unavailable RENAME TO memories");
        } finally {
          db.close();
        }
        break;
      }
      case "request-changed":
        await run({ stopAfter: "observation" });
        await assert.rejects(
          runReact(app.runtime, {
            request: { ...r, goal: "Changed task" },
            model: { provider: provider!, model: model! },
          }),
        );
        await absent();
        break;
      case "permission-revoked": {
        await run({ stopAfter: "observation" });
        const path = join(dir, "policy.json"),
          original = await readFile(path, "utf8");
        await writeFile(
          path,
          JSON.stringify({ ...JSON.parse(original), enabled: false }),
        );
        await assert.rejects(run());
        await absent();
        await writeFile(path, original);
        break;
      }
      case "evidence-tampered": {
        await run({ stopAfter: "report" });
        const file = join(
            dir,
            "evidence",
            (await readdir(join(dir, "evidence")))[0]!,
          ),
          original = await readFile(file, "utf8");
        const saved = JSON.parse(original);
        saved.data.tampered = true;
        await writeFile(file, JSON.stringify(saved));
        // Every persisted observation is checked on report replay, including diagnostic sources.
        await assert.rejects(run());
        await absent();
        await writeFile(file, original);
        break;
      }
      case "cancelled":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        await absent();
        break;
      case "cancel-after-effect":
        await assert.rejects(run({ signal: cancellation.signal }));
        await absent();
        await reopen();
        break;
      case "effect-crash":
      case "observation-0-0-crash":
      case "report-crash":
        await child(name);
        await absent();
        await expire();
        await child("continue");
        break;
      case "publication-retry":
        await mkdir(join(dir, "output"));
        await writeFile(join(dir, "output/report.md"), "occupied");
        await assert.rejects(run());
        await rm(join(dir, "output/report.md"));
        await reopen();
        break;
    }
    const result = await run();
    assert.ok(!("stage" in result));
    const report = result as Report;
    const partial = [
      "max-steps",
      "max-actions",
      "no-progress",
      "deadline",
      "invalid-tool",
      "invalid-arguments",
    ].includes(name);
    if (name === "persistent")
      assert.ok(["needs-human", "partial"].includes(report.status));
    else
      assert.equal(
        report.status,
        partial
          ? "partial"
          : ["permanent", "inspect"].includes(name)
            ? "needs-human"
            : "completed",
      );
    if (partial)
      assert.equal(
        report.stopReason,
        name.startsWith("invalid-") ? "invalid-decision" : name,
      );
    const job = demo.service.db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(r.jobId)!;
    if (report.status === "completed") {
      assert.equal(report.totalCents, 2450);
      assert.equal(job.state, "completed");
      assert.ok(report.evidenceIds.length);
      assert.ok(
        report.turns.some((t) =>
          t.actions.some(
            (a) =>
              a.name ===
              (r.delivery === "browser" ? "job_result_browser" : "job_result"),
          ),
        ),
      );
    }
    if (
      !partial &&
      !["permanent", "persistent", "inspect", "already-completed"].includes(
        name,
      )
    )
      assert.equal(job.retries, 1);
    else assert.equal(job.retries, 0);
    if (name !== "persistent")
      assert.ok(
        Number(
          demo.service.db
            .prepare("SELECT count(*) AS n FROM requests WHERE path='/retry'")
            .get()!.n,
        ) <= 1,
        "idempotent recovery must not resend a committed POST",
      );
    if (["disconnect", "timeout"].includes(name))
      assert.ok(
        report.turns.some((t) =>
          t.observations.some((o) => o.status === "unknown"),
        ),
      );
    if (name === "browser") {
      assert.ok((await readFile(join(dir, "browser.png"))).length > 100);
      assert.match(await readFile(join(dir, "download.csv"), "utf8"), /2450/);
    }
    if (name === "chinese") assert.match(report.summary, /任务/);
    if (name === "wrong-total") assert.equal(injected, 1);
    assert.ok(report.usage.modelCalls >= calls());
    assert.ok(report.usage.modelCalls <= r.maxSteps);
    assert.ok(report.usage.actionCalls <= r.maxActions);
    const output = await readFile(join(dir, "output/report.json"), "utf8");
    assert.deepEqual(JSON.parse(output), report);
    const before = calls(),
      network = demo.service.db
        .prepare("SELECT count(*) AS n FROM requests")
        .get()!.n;
    await reopen();
    assert.deepEqual(await run(), report);
    assert.equal(calls(), before);
    assert.equal(
      demo.service.db.prepare("SELECT count(*) AS n FROM requests").get()!.n,
      network,
    );
    Object.assign(record, {
      status: "passed",
      taskStatus: report.status,
      stopReason: report.stopReason,
      usage: report.usage,
      actions: report.turns.flatMap((t) => t.actions.map((a) => a.name)),
      retries: job.retries,
      artifactSha256: digest(output),
    });
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await app.close();
    Object.assign(record, {
      modelCalls: calls(),
      graphs,
      httpRequests: demo.service.db
        .prepare("SELECT count(*) AS n FROM requests")
        .get()!.n,
    });
    await demo.service.close();
    results.push(record);
    await writeFile(
      resolve(values.report!),
      JSON.stringify(
        { startedAt, provider, model, directory, results },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        name,
        status: record.status,
        modelCalls: calls(),
        error: record.error,
      }),
    );
  }
}
const selected = values.only ? values.only.split(",") : cases;
assert.ok(selected.every((c) => cases.includes(c)));
const errors = [];
for (const name of selected)
  try {
    await runCase(name);
  } catch (e) {
    errors.push(e);
  }
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.status === "passed").length,
    total: results.length,
    modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0),
    report: resolve(values.report!),
  }),
);
if (errors.length)
  throw new AggregateError(errors, "ReAct task experiments failed");
