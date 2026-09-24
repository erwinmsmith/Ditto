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
import { loadRuntimeConfigFile } from "@ditto/core/runtime";
import { contextScopeKey } from "@ditto/core/worker/context";
import type { WorkerDefinition } from "@ditto/core/worker";
import { createTask } from "../examples/_shared/tools/web-search/adapters.ts";
import {
  digest,
  type Report,
} from "../examples/_shared/tools/web-search/domain.ts";
import { searchConfig } from "../examples/_shared/tools/web-search/providers.ts";
import { transportConfig } from "../examples/_shared/tools/web-search/http.ts";
import {
  runWebQa,
  runWebQaLoop,
  scope,
  type Options,
} from "../examples/patterns/web-search-qa/index.ts";
import { defaultRequest } from "../examples/patterns/web-search-qa/fixtures.ts";
import { observedWeb } from "./fixtures/web-search-runtime.ts";
import { webFixture } from "./fixtures/web-search-http.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-web-search-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-web-search-tasks" },
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
  "live-corroboration",
  "complete",
  "cross-check",
  "conflict",
  "hostile-page",
  "no-evidence",
  "clarification",
  "partial-read",
  "all-pages-fail",
  "search-failure",
  "search-throttle",
  "page-throttle",
  "redirect-denied",
  "invalid-citation",
  "unsupported-claim",
  "redis-expiry",
  "redis-unavailable",
  "memory-unavailable",
  "request-changed",
  "permission-revoked",
  "snapshot-tampered",
  "cancelled",
  "page-effect-crash",
  "read-crash",
  "report-crash",
  "publication-retry",
];
const results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
async function runCase(name: string) {
  console.log(JSON.stringify({ name, event: "started" }));
  const live = name.startsWith("live-"),
    fixture = live ? undefined : await webFixture(),
    dir = join(directory, name);
  const search = live
    ? searchConfig()
    : { engine: "mediawiki" as const, endpoint: fixture!.endpoint };
  const transport = live ? transportConfig() : { allowLoopbackTest: true };
  const r = await createTask(
    dir,
    defaultRequest(
      live
        ? {
            crossCheck: name === "live-corroboration",
            question:
              name === "live-corroboration"
                ? "Does SQLite require a separate server process? Check different sources."
                : "What is SQLite, and does it require a separate server process?",
          }
        : {
            question:
              name === "clarification"
                ? "What about that?"
                : name === "no-evidence"
                  ? "What is the fuel price on planet Zark?"
                  : "How many members does Pavo Standard support?",
            allowedOrigins: fixture!.origins,
            referenceUrls: ["cross-check", "conflict"].includes(name)
              ? [fixture!.reference]
              : [],
            crossCheck: name === "cross-check",
            allowPartial: ["partial-read", "redirect-denied"].includes(name),
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
  fixture?.set({
    fault:
      (
        {
          "partial-read": "partial",
          "all-pages-fail": "all-pages-fail",
          "search-failure": "search-failure",
          "search-throttle": "search-throttle",
          "page-throttle": "page-throttle",
          "redirect-denied": "redirect-denied",
        } as Record<string, string>
      )[name] ?? "",
    conflict: name === "conflict",
    hostile: name === "hostile-page",
  });
  const spans: string[] = [],
    graphs: string[] = [],
    children: { modelCalls: number }[] = [];
  let corrupt = ["invalid-citation", "unsupported-claim"].includes(name),
    http = 0;
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
            if (corrupt) {
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
    observedWeb(
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
      runWebQaLoop,
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
      await readFile(join(dir, "output/answer.json")).then(
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
          "scripts/fixtures/web-search-child.ts",
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
      case "search-failure":
      case "all-pages-fail":
        await assert.rejects(run(), /unavailable/);
        await absent();
        fixture!.set({});
        break;
      case "invalid-citation":
        await assert.rejects(run(), /citation/);
        await absent();
        corrupt = false;
        break;
      case "unsupported-claim":
        await assert.rejects(run(), /Grounding/);
        await absent();
        corrupt = false;
        break;
      case "redis-expiry":
        await run({ stopAfter: "read" });
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
        await run({ stopAfter: "read" });
        await assert.rejects(
          runWebQa(app.runtime, {
            request: { ...r, question: "Changed question" },
            model: { provider: provider!, model: model! },
          }),
        );
        await absent();
        break;
      case "permission-revoked": {
        await run({ stopAfter: "read" });
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
      case "snapshot-tampered": {
        await run({ stopAfter: "read" });
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
      case "read-crash":
      case "report-crash":
        await child(name);
        await absent();
        await expire();
        await child("continue");
        break;
      case "publication-retry":
        await mkdir(join(dir, "output"));
        await writeFile(join(dir, "output/answer.md"), "occupied");
        await assert.rejects(run());
        await rm(join(dir, "output/answer.md"));
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
          : ["no-evidence", "redirect-denied"].includes(name)
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
    if (r.crossCheck)
      assert.ok(report.verification.every((c) => c.status === "corroborated"));
    if (["partial-read", "redirect-denied"].includes(name))
      assert.ok(report.failures.length);
    if (name.includes("throttle"))
      assert.ok(fixture!.requests.some((r) => r.status === 429));
    for (const claim of report.answer.claims)
      for (const citation of claim.citations) {
        const evidence = report.evidence.find((e) => e.id === citation.chunkId);
        assert.ok(evidence);
        assert.ok(evidence.text.includes(citation.quote));
        assert.ok(r.allowedOrigins.includes(new URL(evidence.uri).origin));
      }
    if (name === "clarification") assert.equal(http, 0);
    const output = await readFile(join(dir, "output/answer.json"), "utf8");
    assert.deepEqual(JSON.parse(output), report);
    assert.ok(
      (await readFile(join(dir, "output/answer.md"), "utf8")).includes(
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
      graphs.includes("web-memory-read") && graphs.includes("web-tool"),
    );
    Object.assign(record, {
      status: "passed",
      answerStatus: report.answer.status,
      origins: [...new Set(report.evidence.map((e) => new URL(e.uri).origin))],
      claims: report.answer.claims.length,
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
      httpRequests: http,
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
  throw new AggregateError(failures, "Web-search task experiments failed");
