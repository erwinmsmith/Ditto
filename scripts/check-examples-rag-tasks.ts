import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createRetrievalWorker } from "@codesoul-co/ditto-retrieval";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { RagAdapters } from "../examples/_shared/tools/rag/adapters.ts";
import {
  digest,
  type Request,
  type Report,
} from "../examples/_shared/tools/rag/domain.ts";
import {
  createFixture,
  seedInternalKnowledge,
} from "../examples/patterns/rag-qa/fixtures.ts";
import {
  runRag,
  restoreContext,
  scope,
  memoryKey,
  type Options,
} from "../examples/patterns/rag-qa/index.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    only: { type: "string" },
    report: {
      type: "string",
      default: ".examples-rag-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-rag-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model;
assert.ok(model);
const cases: {
  name: string;
  request?: Partial<Request>;
  status?: Report["answer"]["status"];
  match?: RegExp;
}[] = [
  { name: "policy", match: /七天|7\s*天/ },
  {
    name: "product",
    request: {
      sourceIds: ["product"],
      question: "Atlas 标准版和企业版各支持多少成员，数据保留多久？",
    },
    match: /25[\s\S]*200|200[\s\S]*25/,
  },
  {
    name: "contract",
    request: {
      sourceIds: ["contract"],
      question:
        "合同 D-204 的年度服务费和付款期限是什么？故障是否保证四小时修复？",
    },
    match: /48000|48,000|4\.8\s*万/,
  },
  {
    name: "report",
    request: {
      sourceIds: ["report"],
      question: "报告里的本季度收入和同比增长率是多少？",
    },
    match: /20%|20\s*%|百分之二十/,
  },
  {
    name: "internal-memory",
    request: {
      sourceIds: ["internal"],
      question: "内部知识库什么时候由谁检查，修改后需要记录什么？",
    },
    match: /周三|星期三/,
  },
  {
    name: "multi-source",
    request: {
      sourceIds: ["handbook", "product", "internal"],
      question:
        "借用设备要登记什么？Atlas 标准版支持多少成员？内部知识库由谁检查？",
    },
    match: /25/,
  },
  {
    name: "no-evidence",
    request: { question: "火星基地的量子燃料价格是多少？" },
    status: "insufficient-evidence",
  },
  {
    name: "partial-evidence",
    request: { question: "借用设备需要登记什么？设备押金是多少？" },
    status: "insufficient-evidence",
    match: /编号/,
  },
  {
    name: "clarification",
    request: { question: "那个规定是什么？" },
    status: "needs-clarification",
  },
  {
    name: "conflict",
    request: {
      sourceIds: ["handbook", "conflict"],
      question:
        "借用示例设备多少天后需要重新确认归还日期？两份材料有不一致吗？",
    },
    status: "conflicting-evidence",
    match: /五天|5\s*天/,
  },
  {
    name: "untrusted-source",
    request: { sourceIds: ["handbook", "hostile"] },
    match: /编号/,
  },
  {
    name: "external-unavailable",
    request: { sourceIds: ["product"], question: "Atlas 标准版支持多少成员？" },
  },
  {
    name: "internal-unavailable",
    request: { sourceIds: ["internal"], question: "内部知识库什么时候检查？" },
  },
  { name: "storage-faults" },
  { name: "source-failure" },
  { name: "publication-failure" },
  { name: "selected-process-crash" },
  { name: "report-process-crash" },
  { name: "invalid-citation" },
  { name: "unsupported-claim" },
  { name: "index-tamper" },
  { name: "snapshot-tamper" },
  { name: "revoked-access" },
  { name: "denied-access", request: { sourceIds: ["restricted"] } },
];
const selectedCases = values.only
  ? cases.filter((c) => values.only!.split(",").includes(c.name))
  : cases;
assert.ok(selectedCases.length);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  results: Record<string, unknown>[] = [];
for (const scenario of selectedCases) {
  console.log(JSON.stringify({ name: scenario.name, event: "started" }));
  const dir = join(directory, scenario.name);
  await mkdir(dir);
  const r = await createFixture(dir, scenario.request),
    spans: { node: string; input: unknown }[] = [],
    children: { modelCalls: number; spans: string[] }[] = [];
  let corrupt: "citation" | "grounding" | undefined;
  function observed(d: WorkerDefinition): WorkerDefinition {
    return {
      ...d,
      instantiate() {
        const w = d.instantiate();
        return {
          async execute(node, input, context) {
            spans.push({ node, input });
            let value = await w.execute(node, input, context);
            if (node === "INFER.REASONING.SAMPLE" && corrupt) {
              const cloned = structuredClone(value) as {
                output: { message: { content: string } };
              };
              const content = cloned.output.message.content;
              if (corrupt === "citation" && content.includes('"citations"')) {
                const body = JSON.parse(
                  content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                body.claims[0].citations[0].quote = "FABRICATED_SOURCE_999";
                cloned.output.message.content = JSON.stringify(body);
                value = cloned;
              }
              if (corrupt === "grounding" && content.includes('"citations"')) {
                const body = JSON.parse(
                  content
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
                );
                body.claims[0].text =
                  "设备借用完全不需要登记，借用人可永久保留设备。";
                cloned.output.message.content = JSON.stringify(body);
                value = cloned;
              }
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
  let adapters = new RagAdapters(dir, r),
    storage = await openAgentStorage(dir, config);
  const open = () =>
    createDitto({
      config,
      sandbox: { ...config.sandbox, tools: adapters.tools.map((t) => t.name) },
      workers: [
        ...storage.workers,
        createInferWorker(),
        createRetrievalWorker({ providers: adapters.providers }),
        createInteractionWorker({ tools: adapters.tools }),
      ].map(observed),
    });
  let runtime = open();
  await seedInternalKnowledge(runtime);
  const run = (options: Options = {}): ReturnType<typeof runRag> =>
    runRag(runtime, { request: r, model: { provider, model } }, options);
  const reopen = async () => {
    await runtime.close();
    await storage.close();
    adapters.close();
    adapters = new RagAdapters(dir, r);
    storage = await openAgentStorage(dir, config);
    runtime = open();
  };
  const calls = () =>
    spans.filter((s) => s.node === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () =>
    assert.equal(
      await readFile(join(dir, "artifacts/answer.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  async function child(phase: string) {
    await new Promise<void>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/rag-child.ts",
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
      p.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("-crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(stderr || "Expected crash"))
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
    name: scenario.name,
    status: "failed",
    directory: dir,
  };
  try {
    if (scenario.name === "denied-access") {
      await assert.rejects(run());
      assert.equal(calls(), 0);
      await absent();
      record.status = "passed";
      continue;
    }
    switch (scenario.name) {
      case "storage-faults": {
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        await storage.redis.quit();
        await assert.rejects(run());
        assert.equal(calls(), 0);
        await reopen();
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          db.exec("ALTER TABLE memories RENAME TO missing_memories");
          await assert.rejects(run());
          assert.equal(calls(), 0);
          db.exec("ALTER TABLE missing_memories RENAME TO memories");
          db.exec(
            "CREATE TRIGGER fail_report BEFORE INSERT ON memories WHEN NEW.memory_key LIKE '%:report' BEGIN SELECT RAISE(ABORT,'unavailable'); END",
          );
          await assert.rejects(run());
          await absent();
          db.exec("DROP TRIGGER fail_report");
        } finally {
          db.close();
        }
        await reopen();
        break;
      }
      case "external-unavailable": {
        const db = new DatabaseSync(join(dir, "knowledge.sqlite"));
        try {
          db.exec("ALTER TABLE articles RENAME TO missing_articles");
          await assert.rejects(run());
          await absent();
          db.exec("ALTER TABLE missing_articles RENAME TO articles");
        } finally {
          db.close();
        }
        break;
      }
      case "internal-unavailable": {
        const db = new DatabaseSync(join(dir, "memory.sqlite"));
        try {
          db.prepare("DELETE FROM memories WHERE memory_key=?").run(
            "knowledge:demo:maintenance",
          );
          await assert.rejects(run(), /Approved internal knowledge missing/);
          await absent();
        } finally {
          db.close();
        }
        await seedInternalKnowledge(runtime);
        break;
      }
      case "source-failure": {
        const raw = await readFile(join(dir, "handbook.md"), "utf8");
        await rm(join(dir, "handbook.md"));
        await assert.rejects(run());
        await absent();
        await writeFile(join(dir, "handbook.md"), raw);
        await reopen();
        break;
      }
      case "publication-failure":
        await writeFile(join(dir, "artifacts"), "occupied");
        await assert.rejects(run());
        assert.ok(calls() >= 4 && calls() <= 6);
        await rm(join(dir, "artifacts"));
        await reopen();
        break;
      case "selected-process-crash":
      case "report-process-crash": {
        await child(scenario.name.replace("-process", ""));
        await absent();
        const key =
          (config.context.cache?.keyPrefix ?? "ditto:context:") +
          contextScopeKey(scope(r));
        await storage.redis.pExpire(key, 1);
        await delay(20);
        assert.equal(await storage.redis.get(key), null);
        await child("continue");
        assert.ok(calls() >= 4 && calls() <= 6);
        await writeFile(
          join(dir, "handbook.md"),
          "New content after pinned snapshot",
        );
        await reopen();
        await restoreContext(runtime, r);
        break;
      }
      case "invalid-citation":
        corrupt = "citation";
        await assert.rejects(run(), /Unsupported citation/);
        await absent();
        corrupt = undefined;
        break;
      case "unsupported-claim":
        corrupt = "grounding";
        await assert.rejects(run(), /Grounding check failed/);
        await absent();
        corrupt = undefined;
        break;
      case "index-tamper": {
        await run({ stopAfter: "indexed" });
        adapters.db.exec("ALTER TABLE search RENAME TO missing_search");
        await assert.rejects(run());
        await absent();
        adapters.db.exec("ALTER TABLE missing_search RENAME TO search");
        break;
      }
      case "snapshot-tamper": {
        await run({ stopAfter: "selected" });
        const db = new DatabaseSync(join(dir, "corpus.sqlite"), {
          readOnly: true,
        });
        let hash: string;
        try {
          hash = JSON.parse(
            String(
              db.prepare("SELECT payload FROM chunks LIMIT 1").get()!.payload,
            ),
          ).snapshot;
        } finally {
          db.close();
        }
        const path = join(dir, "snapshots", `${hash}.txt`),
          raw = await readFile(path, "utf8");
        await writeFile(path, "tampered");
        await assert.rejects(run());
        await absent();
        await writeFile(path, raw);
        break;
      }
    }
    const result = (await run()) as Report;
    assert.equal(result.answer.status, scenario.status ?? "answered");
    const userAnswer = JSON.stringify(result.answer);
    const claimText = result.answer.claims.map((c) => c.text).join(" ");
    if (scenario.name === "policy")
      for (const term of ["编号", "借用人", "归还日期"])
        assert.ok(claimText.includes(term));
    if (scenario.name === "product")
      for (const term of ["25", "200", "90", "365"])
        assert.ok(claimText.includes(term));
    if (scenario.name === "contract") {
      assert.match(claimText, /30|三十/);
      assert.match(claimText, /不.*(?:保证|承诺|修复)|未.*(?:保证|承诺|修复)/);
    }
    if (scenario.name === "report") assert.match(claimText, /120|一百二十/);
    if (scenario.match) assert.match(userAnswer, scenario.match);
    assert.ok(!userAnswer.includes("CONFIDENTIAL_OTHER_TENANT"));
    assert.ok(!userAnswer.includes("SECRET_OVERRIDE_777"));
    assert.ok(!userAnswer.includes("999 days"));
    if (result.answer.status === "answered")
      assert.equal(result.grounding, "model-checked");
    if (scenario.name === "multi-source")
      assert.deepEqual(
        [...new Set(result.evidence.map((e) => e.kind))].sort(),
        ["document", "external", "internal"],
      );
    if (scenario.name === "internal-memory")
      assert.ok(
        spans.some(
          (s) =>
            s.node === "MEMORY.GET" &&
            JSON.stringify(s.input).includes("knowledge:demo:maintenance"),
        ),
      );
    for (const claim of result.answer.claims)
      for (const cite of claim.citations) {
        const c = result.evidence.find((c) => c.id === cite.chunkId)!;
        assert.ok(c.text.includes(cite.quote));
        const raw = await readFile(
          join(dir, "snapshots", `${c.snapshot}.txt`),
          "utf8",
        );
        assert.equal(digest(raw), c.snapshot);
        assert.equal(
          raw
            .split("\n")
            .slice(c.startLine - 1, c.endLine)
            .join("\n"),
          c.text,
        );
      }
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "artifacts/answer.json"), "utf8")),
      result,
    );
    const markdown = await readFile(join(dir, "artifacts/answer.md"), "utf8");
    assert.ok(markdown.includes(`Status: ${result.answer.status}`));
    const count = calls();
    await reopen();
    assert.deepEqual(await run(), result);
    assert.equal(calls(), count);
    await assert.rejects(
      runRag(runtime, {
        request: { ...r, question: "changed" },
        model: { provider, model },
      }),
      /Request changed/,
    );
    if (scenario.name === "revoked-access") {
      const catalog = JSON.parse(
        await readFile(join(dir, "sources.json"), "utf8"),
      );
      catalog.find((s: { id: string }) => s.id === "handbook").readers = [];
      await writeFile(join(dir, "sources.json"), JSON.stringify(catalog));
      await assert.rejects(run());
      assert.equal(calls(), count);
    }
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
    try {
      assert.ok(
        db
          .prepare("SELECT content FROM memories WHERE memory_key=?")
          .get(memoryKey(r, "report")),
      );
    } finally {
      db.close();
    }
    record.result = result;
    record.storage = {
      context: "redis",
      memory: "sqlite",
      corpus: "sqlite-fts5",
      externalKnowledge: "sqlite",
    };
    record.status = "passed";
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    await runtime.close();
    await storage.close();
    adapters.close();
    Object.assign(record, { spans, children, modelCalls: calls() });
    results.push(record);
    await writeFile(
      resolve(values.report!),
      JSON.stringify({ provider, model, directory, results }, null, 2),
    );
    console.log(
      JSON.stringify({
        name: scenario.name,
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
      directory,
      report: resolve(values.report!),
    },
    null,
    2,
  ),
);
if (failed.length) throw new Error(`${failed.length} RAG tasks failed`);
