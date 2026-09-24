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
import { createDemo } from "../examples/_shared/tools/candidates/adapters.ts";
import {
  check,
  normalized,
  combine,
  type Report,
  type Candidate,
} from "../examples/_shared/tools/candidates/domain.ts";
import {
  runCandidates,
  runCandidatesLoop,
  scope,
  type Options,
} from "../examples/patterns/candidate-selection/index.ts";
import { observedCandidates } from "./fixtures/candidates-runtime.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-candidates-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-candidates-tasks" },
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
  "select",
  "fuse",
  "missing-facts",
  "invalid-candidate",
  "invalid-assessment",
  "hard-rejection",
  "all-rejected",
  "duplicates",
  "tie",
  "threshold",
  "invalid-fusion",
  "rejected-fusion",
  "strict-fusion",
  "max-model-calls",
  "deadline",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "source-changed",
  "permission-revoked",
  "candidate-tampered",
  "grade-tampered",
  "cancelled",
  "cancel-after-candidate",
  "effect-crash",
  "generate-0-crash",
  "assess-0-crash",
  "fusion-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [];
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const dir = join(directory, name),
    fuse = [
      "fuse",
      "invalid-fusion",
      "rejected-fusion",
      "strict-fusion",
      "fusion-crash",
    ].includes(name);
  const r = await createDemo(
    dir,
    {
      mode: fuse ? "fuse" : "select",
      count: ["select", "fuse"].includes(name) ? 3 : 2,
      allowFallback: name !== "strict-fusion",
      maxModelCalls: name === "max-model-calls" ? 1 : 10,
      deadlineSeconds: name === "deadline" ? 1 : 600,
    },
    name === "missing-facts",
  );
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  let injected = 0,
    mixed = false;
  let firstCandidate: string | undefined;
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
            name === "cancel-after-candidate" &&
            !injected &&
            node === "INTERACTION.ACT.TOOL" &&
            JSON.stringify(input).includes('"candidates_save"')
          ) {
            injected++;
            controller.abort();
          }
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((n) => n === node).length}.json`),
              JSON.stringify(out, null, 2),
            );
            const raw = JSON.stringify(input),
              isGenerate = raw.includes("Generate ONE product-copy"),
              isJudge = raw.includes("Evaluate this ONE candidate"),
              isMixer = raw.includes("Choose complementary fields");
            const changed = structuredClone(out) as {
              output: { message: { content: string } };
            };
            if (isGenerate && name === "invalid-candidate" && !injected) {
              changed.output.message.content = "not JSON";
              injected++;
              return changed;
            }
            if (isGenerate && name === "duplicates") {
              if (!firstCandidate)
                firstCandidate = changed.output.message.content;
              else {
                changed.output.message.content = firstCandidate;
                injected++;
                return changed;
              }
            }
            if (
              isGenerate &&
              (name === "all-rejected" ||
                (name === "hard-rejection" && !injected))
            ) {
              const c = JSON.parse(
                changed.output.message.content
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              c.cta = "Buy unsupported upgrade";
              changed.output.message.content = JSON.stringify(c);
              injected++;
              return changed;
            }
            if (isJudge) {
              const a = JSON.parse(
                changed.output.message.content
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              let mutate = false;
              if (name === "invalid-assessment" && !injected) {
                a.candidateId = "0".repeat(64);
                mutate = true;
              }
              if (["tie", "threshold"].includes(name)) {
                a.scores = {
                  clarity: name === "tie" ? 4 : 0,
                  fit: name === "tie" ? 4 : 0,
                  credibility: name === "tie" ? 4 : 0,
                };
                a.verdict = "pass";
                a.issues = [];
                mutate = true;
              }
              if (
                mixed &&
                ["rejected-fusion", "strict-fusion"].includes(name)
              ) {
                a.verdict = "reject";
                a.issues = ["Injected incoherent fusion for validation."];
                mutate = true;
              }
              if (mutate) {
                changed.output.message.content = JSON.stringify(a);
                injected++;
                return changed;
              }
            }
            if (isMixer) {
              mixed = true;
              if (name === "invalid-fusion") {
                const f = JSON.parse(
                  changed.output.message.content
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                f.headlineFrom = "0".repeat(64);
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
  let app: Awaited<ReturnType<typeof observedCandidates>> | undefined;
  const open = async () =>
    (app = await observedCandidates(dir, r, config, observe));
  const run = (options: Options = {}) =>
    app!.runtime.loop(
      runCandidatesLoop,
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
          "scripts/fixtures/candidates-child.ts",
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
      if (name === "cancel-after-candidate")
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
        await run({ stopAfter: "candidate" });
        if (name === "redis-expiry") {
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
                  ? "product.json"
                  : "policy.json",
            ),
            saved = await readFile(path, "utf8"),
            v = JSON.parse(saved);
          if (name === "request-changed") v.goal += " changed";
          else if (name === "source-changed") v.product = "Another product";
          else v.enabled = false;
          await writeFile(path, JSON.stringify(v));
          await assert.rejects(run());
          await writeFile(path, saved);
        }
        if (name === "deadline") await delay(1100);
      }
      if (["candidate-tampered", "grade-tampered"].includes(name)) {
        await run({
          stopAfter: name === "candidate-tampered" ? "candidate" : "assessment",
        });
        const sub = name === "candidate-tampered" ? "candidates" : "grades",
          path = join(dir, sub, (await readdir(join(dir, sub)))[0]!),
          saved = await readFile(path, "utf8");
        await writeFile(path, saved + " ");
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
    if (["max-model-calls", "deadline"].includes(name)) {
      assert.equal(result.status, "partial");
      assert.equal(result.stopReason, name);
      assert.ok(
        (await readFile(join(dir, "output/report.md"), "utf8")).includes(
          "not evaluated",
        ),
      );
    } else if (
      ["missing-facts", "all-rejected", "threshold", "strict-fusion"].includes(
        name,
      )
    ) {
      assert.equal(result.status, "needs-human");
      assert.equal(result.finalId, null);
    } else {
      assert.equal(result.status, "completed");
      assert.ok(result.finalId);
      const c = JSON.parse(
        await readFile(join(dir, "output/copy.json"), "utf8"),
      );
      assert.deepEqual(check(c, await app!.adapters.load()), []);
      assert.deepEqual(c, await app!.adapters.loadCandidate(result.finalId));
      const md = await readFile(join(dir, "output/copy.md"), "utf8");
      assert.ok(md.includes(c.cta));
    }
    if (result.status !== "completed")
      await assert.rejects(access(join(dir, "output/copy.json")));
    if (["fuse", "fusion-crash"].includes(name)) {
      assert.equal(result.applied, "fuse");
      assert.ok(result.fusion && result.fusionGradeId);
      const parents = new Map<string, Candidate>();
      for (const x of result.ranking.slice(0, 2))
        parents.set(
          x.candidateId,
          await app!.adapters.loadCandidate(x.candidateId),
        );
      const merged = combine(result.fusion, parents);
      assert.deepEqual(
        merged,
        await app!.adapters.loadCandidate(result.finalId!),
      );
      assert.ok(
        [...parents.values()].every(
          (c) => normalized(c) !== normalized(merged),
        ),
      );
    }
    if (["invalid-fusion", "rejected-fusion"].includes(name)) {
      assert.equal(result.applied, "fallback");
      assert.equal(result.finalId, result.ranking[0]!.candidateId);
    }
    if (
      [
        "invalid-candidate",
        "invalid-assessment",
        "hard-rejection",
        "duplicates",
      ].includes(name)
    ) {
      assert.equal(result.ranking.length, 1);
      assert.ok(result.entries.some((e) => e.error));
    }
    if (name === "tie") {
      assert.equal(result.ranking.length, 2);
      assert.equal(result.ranking[0]!.score, result.ranking[1]!.score);
      assert.equal(
        result.finalId,
        result.ranking.map((x) => x.candidateId).sort()[0],
      );
    }
    if (
      [
        "invalid-candidate",
        "invalid-assessment",
        "hard-rejection",
        "duplicates",
        "invalid-fusion",
        "rejected-fusion",
        "strict-fusion",
      ].includes(name)
    )
      assert.equal(injected, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "output/report.json"), "utf8")),
      result,
    );
    const before = spans.filter((n) => n === "INFER.REASONING.SAMPLE").length;
    assert.deepEqual(
      await runCandidates(app!.runtime, {
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
      applied: result.applied,
      modelCalls: calls,
      qualified: result.ranking.length,
      graphs: [...new Set(graphs)],
      directory: dir,
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
              business: "catalog and immutable copy artifacts",
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
