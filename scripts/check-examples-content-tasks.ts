import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { contentTools } from "../examples/_shared/tools/content/tools.ts";
import {
  modes,
  digest,
  validateDraft,
  validateMaterial,
  validateReview,
  type Mode,
  type Material,
} from "../examples/_shared/tools/content/domain.ts";
import { htmlEscape } from "../examples/_shared/tools/content/render.ts";
import { createFixture } from "../examples/_shared/tools/content/fixtures.ts";
import { sandbox } from "../examples/capabilities/content/cli.ts";
import {
  runContent,
  scope,
  memoryKey,
  type Options,
  type Report,
} from "../examples/capabilities/content/shared.ts";
const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    report: {
      type: "string",
      default: ".examples-content-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-content-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  provider = values.provider ?? config.model?.provider;
assert.ok(provider && config.providers[provider]);
const model = config.providers[provider].model ?? config.model?.model;
assert.ok(model);
const cases: { name: string; mode: Mode }[] = [
  ...modes.map((mode) => ({ name: `${mode}-complete`, mode })),
  ...modes.map((mode) => ({ name: `${mode}-cache-expiry`, mode })),
  ...[
    "redis-unavailable",
    "memory-unavailable",
    "source-missing",
    "source-symlink",
    "source-changed",
    "snapshot-resume",
    "input-changed",
    "wrong-citation",
    "wrong-number",
    "wrong-language",
    "review-rejected",
    "publication-retry",
    "cancel-before-work",
    "material-process-crash",
    "draft-process-crash",
    "review-process-crash",
    "publish-effect-crash",
  ].map((name) => ({ name, mode: "generate" as const })),
  { name: "conversion-content-loss", mode: "convert" },
];
limitCapabilityCases(cases);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  startedAt = new Date().toISOString(),
  results: Record<string, unknown>[] = [];
let reportWrites: Promise<void> = Promise.resolve();
async function runCase(item: (typeof cases)[number]) {
  console.log(JSON.stringify({ name: item.name, event: "started" }));
  const dir = join(directory, item.name);
  await mkdir(dir);
  const r = await createFixture(dir, item.mode),
    spans: { node: string; input: unknown }[] = [],
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
            let result = await w.execute(node, input, context);
            if (corrupt && node === "INFER.REASONING.SAMPLE") {
              const changed = structuredClone(result) as {
                output: { message: { content: string } };
              };
              const value = JSON.parse(
                changed.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              if (value.sections && corrupt !== "review") {
                if (corrupt === "citation")
                  value.sections[0].citations[0].quote = "fabricated citation";
                if (corrupt === "number")
                  value.sections[0].text += " 配额为 99999999。";
                if (corrupt === "language") value.language = "en";
                if (corrupt === "conversion") value.sections[0].text += "改写";
              } else if (
                corrupt === "review" &&
                typeof value.approved === "boolean"
              ) {
                value.approved = false;
                value.checks.fidelity = false;
                value.issues = ["Injected review rejection"];
              }
              changed.output.message.content = JSON.stringify(value);
              result = changed;
            }
            return result;
          },
          async dispose() {
            await w.dispose?.();
          },
        };
      },
    };
  }
  let storage = await openAgentStorage(dir, config);
  const open = () =>
    createDitto({
      config,
      sandbox: sandbox(config),
      workers: [
        ...storage.workers,
        createInferWorker(),
        createInteractionWorker({ tools: contentTools(dir, r) }),
      ].map(observed),
    });
  let runtime = open();
  const entry = await import(`../examples/capabilities/content/${r.mode}.ts`) as { run: typeof runContent };
  const run = (options: Options = {}): ReturnType<typeof runContent> =>
    entry.run(
      runtime,
      { request: r, model: { provider: provider!, model: model! } },
      options,
    );
  const reopen = async () => {
    await runtime.close();
    await storage.close();
    storage = await openAgentStorage(dir, config);
    runtime = open();
  };
  const calls = () =>
    spans.filter((s) => s.node === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
  const absent = async () =>
    assert.equal(
      await readFile(join(dir, "artifacts/manifest.json")).then(
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
          "scripts/fixtures/content-child.ts",
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
    status: "failed",
    directory: dir,
  };
  try {
    if (item.name.endsWith("cache-expiry")) {
      await run({ stopAfter: "draft" });
      await expire();
      await reopen();
    }
    switch (item.name) {
      case "redis-unavailable":
        await storage.redis.quit();
        await assert.rejects(run());
        assert.equal(calls(), 0);
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
      case "source-missing":
      case "source-symlink":
      case "source-changed": {
        const path = join(dir, "inputs/brief.md"),
          original = await readFile(path, "utf8");
        await rm(path);
        if (item.name === "source-symlink")
          await symlink(join(dir, "inputs/draft.md"), path);
        if (item.name === "source-changed")
          await writeFile(path, "Unapproved source replacement");
        await assert.rejects(run());
        await absent();
        assert.equal(calls(), 0);
        await rm(path, { force: true });
        await writeFile(path, original);
        break;
      }
      case "snapshot-resume":
        await run({ stopAfter: "material" });
        await writeFile(
          join(dir, "inputs/brief.md"),
          "Changed after committed snapshot",
        );
        await expire();
        await reopen();
        break;
      case "input-changed":
        await run({ stopAfter: "material" });
        await assert.rejects(
          runContent(runtime, {
            request: {
              ...r,
              anchors: ["different", r.anchors[1]!, r.anchors[2]!],
            },
            model: { provider: provider!, model: model! },
          }),
          /Request changed/,
        );
        break;
      case "wrong-citation":
      case "wrong-number":
      case "wrong-language":
      case "conversion-content-loss":
        corrupt = item.name.startsWith("wrong-")
          ? item.name.slice(6)
          : "conversion";
        await assert.rejects(run());
        await absent();
        corrupt = undefined;
        break;
      case "review-rejected":
        corrupt = "review";
        await assert.rejects(run(), /review rejected/);
        await absent();
        corrupt = undefined;
        break;
      case "publication-retry":
        await mkdir(join(dir, "artifacts"));
        await writeFile(
          join(dir, "artifacts/content.html"),
          "Conflicting HTML",
        );
        await assert.rejects(run());
        await absent();
        assert.ok(await readFile(join(dir, "artifacts/content.json")));
        await rm(join(dir, "artifacts/content.html"));
        await reopen();
        break;
      case "cancel-before-work":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        break;
      case "material-process-crash":
      case "draft-process-crash":
      case "review-process-crash":
        await child(item.name.replace("-process", ""));
        await absent();
        await expire();
        await child("continue");
        break;
      case "publish-effect-crash":
        await child(item.name);
        assert.ok(await readFile(join(dir, "artifacts/manifest.json")));
        await expire();
        await child("continue");
        break;
    }
    const result = (await run()) as Report;
    assert.equal(result.mode, r.mode);
    validateReview(result.review);
    assert.equal(
      calls(),
      [
        "wrong-citation",
        "wrong-number",
        "wrong-language",
        "conversion-content-loss",
        "review-rejected",
      ].includes(item.name)
        ? 3
        : 2,
    );
    const db = new DatabaseSync(join(dir, "memory.sqlite"), { readOnly: true });
    let material: Material;
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM memories").get()!.n,
        5,
      );
      material = validateMaterial(
        JSON.parse(
          String(
            db
              .prepare("SELECT content FROM memories WHERE memory_key=?")
              .get(memoryKey(r, "material"))!.content,
          ),
        ).value,
        r,
      );
      assert.deepEqual(
        JSON.parse(
          String(
            db
              .prepare("SELECT content FROM memories WHERE memory_key=?")
              .get(memoryKey(r, "report"))!.content,
          ),
        ).value,
        result,
      );
    } finally {
      db.close();
    }
    validateDraft(result.draft, r, material);
    const document = JSON.parse(
      await readFile(join(dir, "artifacts/content.json"), "utf8"),
    );
    assert.deepEqual(document.sections, result.draft.sections);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, "artifacts/review.json"), "utf8")),
      result.review,
    );
    const html = await readFile(join(dir, "artifacts/content.html"), "utf8"),
      markdown = await readFile(join(dir, "artifacts/content.md"), "utf8");
    assert.equal(
      (html.match(/<section>/g) ?? []).length,
      result.draft.sections.length,
    );
    for (const section of result.draft.sections)
      assert.ok(html.includes(`<p>${htmlEscape(section.text)}</p>`));
    assert.ok(markdown.startsWith("# "));
    assert.ok(!/<script\b/i.test(html));
    for (const ref of document.references) {
      const original = await readFile(join(dir, "artifacts", ref.file), "utf8");
      assert.equal(digest(original), ref.sha256);
      assert.equal(original.split("\n")[ref.line - 1], ref.quote);
      assert.ok(html.includes(`id="${ref.id}"`));
      assert.ok(markdown.includes(`${ref.file}#L${ref.line}`));
    }
    for (const file of result.delivery.files) {
      const bytes = await readFile(join(dir, "artifacts", file.file));
      assert.equal(bytes.length, file.bytes);
      assert.equal(digest(bytes.toString("utf8")), file.sha256);
    }
    const manifest = JSON.parse(
      await readFile(join(dir, "artifacts/manifest.json"), "utf8"),
    );
    assert.equal(manifest.files.length, result.delivery.files.length - 1);
    for (const file of manifest.files)
      assert.ok(
        result.delivery.files.some(
          (f) => f.file === file.file && f.sha256 === file.sha256,
        ),
      );
    const before = calls();
    await expire();
    await reopen();
    assert.deepEqual(await run(), result);
    assert.equal(calls(), before);
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
      delivery: result.delivery,
      review: result.review,
    });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    await runtime.close();
    await storage.close();
    Object.assign(record, { spans, children, modelCalls: calls() });
    results.push(record);
    await (reportWrites = reportWrites.then(() =>
      writeFile(
        resolve(values.report!),
        JSON.stringify(
          {
            startedAt,
            provider,
            model,
            directory,
            targets:
              "Real model generation/review + Redis + SQLite Memory + Markdown/JSON/HTML files and source snapshots",
            results,
          },
          null,
          2,
        ),
      ),
    ));
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
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < cases.length) await runCase(cases[next++]!);
  }),
);
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
  throw new Error(`${failed.length} content task experiments failed`);
