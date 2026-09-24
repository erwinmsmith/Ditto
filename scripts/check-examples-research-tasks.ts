import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createTask } from "../examples/_shared/tools/research/adapters.ts";
import { type Report } from "../examples/_shared/tools/research/domain.ts";
import { digest } from "../examples/_shared/tools/evidence.ts";
import { searchConfig } from "../examples/_shared/tools/web-search/providers.ts";
import { transportConfig } from "../examples/_shared/tools/web-search/http.ts";
import {
  runResearch,
  runResearchLoop,
  scope,
  type Options,
} from "../examples/patterns/deep-research/index.ts";
import { defaultRequest } from "../examples/patterns/deep-research/fixtures.ts";
import { observedResearch } from "./fixtures/research-runtime.ts";
import { researchFixture } from "./fixtures/research-http.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-research-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-research-tasks" },
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
  "live-internet",
  "live-adaptive",
  "adaptive-research",
  "chinese-research",
  "invalid-citation",
  "unsupported-claim",
  "repair-claim",
  "model-budget",
  "cross-check",
  "conflict",
  "hostile-page",
  "no-evidence",
  "clarification",
  "round-budget",
  "search-budget",
  "page-budget",
  "no-progress",
  "deadline",
  "search-failure",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "permission-revoked",
  "snapshot-tampered",
  "cancelled",
  "page-effect-crash",
  "round-1-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const live = name.startsWith("live-"),
    fixture = live ? undefined : await researchFixture(),
    dir = join(directory, name);
  const search = live
    ? searchConfig()
    : { engine: "mediawiki" as const, endpoint: fixture!.endpoint };
  const transport = live ? transportConfig() : { allowLoopbackTest: true };
  const r = await createTask(
    dir,
    defaultRequest(
      live
        ? name === "live-adaptive"
          ? {
              question:
                "Research SQLite serverless architecture and the read/write concurrency properties of its write-ahead logging mode.",
              scope:
                "SQLite architecture and WAL concurrency only. Use short search topic names such as SQLite or Write-ahead logging, not full sentences.",
              referenceUrls: ["https://www.sqlite.org/serverless.html"],
              maxPages: 1,
              maxRounds: 3,
            }
          : {}
        : {
            question:
              name === "clarification"
                ? "What about that?"
                : name === "chinese-research"
                  ? "研究 Pavo Standard 的团队人数上限和审计日志保留时间，说明采购时需要注意的限制。"
                  : "Research Pavo Standard team size and audit-log retention duration for a purchasing decision.",
            scope:
              name === "clarification"
                ? "No prior subject or conversation is available."
                : "Pavo Standard only. Compare actual membership capacity and audit-log retention evidence; no unsupported recommendation.",
            allowedOrigins: fixture!.origins,
            referenceUrls: [],
            crossCheck: name === "cross-check",
            maxQueries: 2,
            maxRounds: name === "round-budget" ? 1 : 3,
            maxModelCalls: name === "model-budget" ? 8 : 12,
            maxSearches: name === "search-budget" ? 2 : 6,
            maxReadPages: name === "page-budget" ? 1 : 10,
            researchSeconds: name === "deadline" ? 1 : 600,
          },
    ),
    search,
  );
  // Child-process fixtures never need production provider credentials.
  if (!live)
    await writeFile(
      join(dir, "harness.json"),
      JSON.stringify({ search, transport }),
    );
  fixture?.set(
    (
      {
        conflict: "conflict",
        "hostile-page": "hostile",
        "no-evidence": "empty",
        "no-progress": "no-progress",
        "search-failure": "unavailable",
      } as Record<string, string>
    )[name] ?? "normal",
  );
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  const corrupt = [
    "invalid-citation",
    "unsupported-claim",
    "repair-claim",
  ].includes(name);
  let corruptDrafts = 0;
  let http = 0;
  const observe = (d: WorkerDefinition): WorkerDefinition => ({
    ...d,
    instantiate() {
      const w = d.instantiate();
      return {
        async execute(node, input, context) {
          spans.push(node);
          const result = await w.execute(node, input, context);
          if (node === "INFER.REASONING.SAMPLE") {
            await writeFile(
              join(dir, `model-${spans.filter((s) => s === node).length}.json`),
              JSON.stringify(result, null, 2),
            );
            if (corrupt && (name !== "repair-claim" || corruptDrafts === 0)) {
              const changed = structuredClone(result) as {
                output: { message: { content: string } };
              };
              const a = JSON.parse(
                changed.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (a.claims?.[0]?.text) {
                corruptDrafts++;
                if (name === "invalid-citation")
                  a.claims[0].citations[0].quote =
                    "Fabricated quotation absent from the source.";
                else a.claims[0].text = "Pavo Standard supports 9999 members.";
                changed.output.message.content = JSON.stringify(a);
                return changed;
              }
            }
          }
          return result;
        },
        async dispose() {
          await w.dispose?.();
        },
      };
    },
  });
  const open = () =>
    observedResearch(
      dir,
      r,
      config,
      search,
      {
        ...transport,
        onRequest() {
          http++;
        },
      },
      observe,
    );
  let app = await open();
  const run = (options: Options = {}) =>
    app.runtime.loop(
      runResearchLoop,
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
  const calls = () =>
    spans.filter((s) => s === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
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
          "scripts/fixtures/research-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
          "--provider",
          provider!,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      p.stderr.on("data", (s) => (err += String(s)));
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("-crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(err || "Expected crash"))
          : code === 0
            ? done()
            : reject(new Error(err)),
      );
    });
    children.push(
      JSON.parse(await readFile(join(dir, `child-${phase}.json`), "utf8")),
    );
  }
  const record: Record<string, unknown> = {
    name,
    transport: live ? "live-internet" : "controlled-http",
    directory: dir,
    status: "failed",
  };
  try {
    switch (name) {
      case "model-budget": {
        await run({ stopAfter: "plan" });
        // Simulate reservations surviving uncertain terminated model attempts.
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          const row = db
            .prepare("SELECT id,content FROM memories WHERE memory_key=?")
            .get(`${scope(r).sessionId}:usage`) as {
            id: string;
            content: string;
          };
          const saved = JSON.parse(row.content);
          saved.value.modelCalls = r.maxModelCalls - 4;
          db.prepare("UPDATE memories SET content=? WHERE id=?").run(
            JSON.stringify(saved),
            row.id,
          );
        } finally {
          db.close();
        }
        await reopen();
        break;
      }
      case "search-failure":
        await assert.rejects(run(), /unavailable|Tool failed/);
        await absent();
        fixture!.set("normal");
        break;
      case "invalid-citation":
        await assert.rejects(run(), /citation/);
        await absent();
        Object.assign(record, {
          status: "passed",
          rejected: "invalid-citation",
        });
        return;
      case "unsupported-claim":
        await assert.rejects(run(), /Grounding/);
        await absent();
        Object.assign(record, {
          status: "passed",
          rejected: "unsupported-claim",
        });
        return;
      case "redis-expiry":
        await run({ stopAfter: "round" });
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
        await run({ stopAfter: "round" });
        await assert.rejects(
          runResearch(app.runtime, {
            request: { ...r, question: "Changed question" },
            model: { provider: provider!, model: model! },
          }),
        );
        await absent();
        break;
      case "permission-revoked": {
        await run({ stopAfter: "round" });
        const path = join(dir, "research-policy.json"),
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
      case "snapshot-tampered": {
        await run({ stopAfter: "round" });
        const path = join(
            dir,
            "pages",
            (await readdir(join(dir, "pages")))[0]!,
          ),
          original = await readFile(path, "utf8");
        await writeFile(
          path,
          JSON.stringify({ ...JSON.parse(original), html: "tampered" }),
        );
        await assert.rejects(run());
        await absent();
        await writeFile(path, original);
        break;
      }
      case "cancelled":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        await absent();
        break;
      case "page-effect-crash":
      case "round-1-crash":
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
    assert.ok(!("status" in result));
    const report = result as Report;
    assert.equal(
      report.answer.status,
      name === "clarification"
        ? "needs-clarification"
        : name === "conflict"
          ? "conflicting-evidence"
          : [
                "no-evidence",
                "model-budget",
                "round-budget",
                "search-budget",
                "page-budget",
                "no-progress",
                "deadline",
              ].includes(name)
            ? "insufficient-evidence"
            : "answered",
    );
    if (report.answer.claims.length) {
      assert.equal(report.grounding, "model-checked");
      assert.ok(!report.answer.claims.some((c) => /9999/.test(c.text)));
    }
    if (!live && report.answer.status === "answered")
      assert.match(report.answer.claims.map((c) => c.text).join(" "), /25/);
    if (name === "conflict")
      assert.match(report.answer.claims.map((c) => c.text).join(" "), /40/);
    if (r.crossCheck && report.answer.status === "answered")
      assert.ok(report.verification.every((c) => c.status === "corroborated"));
    for (const claim of report.answer.claims)
      for (const citation of claim.citations) {
        const evidence = report.evidence.find((e) => e.id === citation.chunkId);
        assert.ok(evidence);
        assert.ok(evidence.text.includes(citation.quote));
        assert.ok(r.allowedOrigins.includes(new URL(evidence.uri).origin));
      }
    if (name === "repair-claim") {
      assert.equal(corruptDrafts, 1);
      assert.ok(calls() >= 7);
    }
    if (name === "clarification" || name === "deadline") assert.equal(http, 0);
    if (name === "live-adaptive") {
      assert.ok(
        report.rounds.length >= 2,
        "public-web task must use follow-up research",
      );
      assert.ok(
        report.rounds[0]!.assessment.coverage.some((c) => c.status === "gap"),
      );
      assert.ok(report.rounds.slice(1).some((r) => r.newEvidence > 0));
      assert.ok(
        report.evidence.some(
          (e) => new URL(e.uri).origin === "https://en.wikipedia.org",
        ),
      );
    }
    if (!live && report.answer.status === "answered") {
      assert.ok(
        report.rounds.length >= 2,
        "must discover missing information in a later round",
      );
      assert.ok(
        report.rounds[0]!.assessment.coverage.some((c) => c.status === "gap"),
      );
      assert.match(
        report.rounds
          .slice(1)
          .flatMap((r) => r.queries)
          .join(" "),
        /meridian/i,
      );
      assert.match(
        report.answer.claims.map((c) => c.text).join(" "),
        /30|thirty/,
      );
      assert.equal(report.stopReason, "coverage-complete");
      assert.ok(report.rounds[1]!.newEvidence > 0);
    }
    if (
      [
        "model-budget",
        "round-budget",
        "search-budget",
        "page-budget",
        "no-progress",
        "deadline",
      ].includes(name)
    )
      assert.equal(report.stopReason, name);
    assert.ok(report.usage.modelCalls <= r.maxModelCalls);
    assert.ok(
      report.usage.modelCalls >= calls(),
      "model reservations survive recovery",
    );
    assert.ok(report.usage.searches <= r.maxSearches);
    assert.ok(report.usage.pages <= r.maxReadPages);
    const output = await readFile(join(dir, "output/report.json"), "utf8");
    assert.deepEqual(JSON.parse(output), report);
    assert.ok(
      (await readFile(join(dir, "output/report.md"), "utf8")).includes(
        report.question,
      ),
    );
    const before = calls(),
      network = http;
    const replay = await run();
    assert.deepEqual(replay, report);
    assert.equal(calls(), before);
    assert.equal(http, network);
    assert.ok(
      graphs.includes("research-memory-read") &&
        graphs.includes("research-tool"),
    );
    Object.assign(record, {
      status: "passed",
      answerStatus: report.answer.status,
      origins: [...new Set(report.evidence.map((e) => new URL(e.uri).origin))],
      claims: report.answer.claims.length,
      rounds: report.rounds.length,
      stopReason: report.stopReason,
      usage: report.usage,
      artifactSha256: digest(output),
    });
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await app.close();
    await fixture?.close();
    Object.assign(record, {
      modelCalls: calls(),
      httpRequests: fixture ? fixture.requests.length : http,
      graphs,
      controlledRequests: fixture?.requests,
    });
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
assert.ok(selected.every((n) => cases.includes(n)));
const failures = [];
for (const name of selected) {
  try {
    await runCase(name);
  } catch (e) {
    failures.push(e);
  }
}
console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.status === "passed").length,
      total: results.length,
      modelCalls: results.reduce((n, r) => n + Number(r.modelCalls), 0),
      report: resolve(values.report!),
    },
    null,
    2,
  ),
);
if (failures.length)
  throw new AggregateError(failures, "Research task experiments failed");
