import { limitCapabilityCases } from "./lib/capability-cases.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto/runtime";
import type { WorkerDefinition } from "@codesoul-co/ditto/worker";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { contextScopeKey } from "@codesoul-co/ditto/worker/context";
import { openAgentStorage } from "../examples/_shared/tools/storage/workers.ts";
import { mediaTools } from "../examples/_shared/tools/multimodal/tools.ts";
import { createFixture } from "../examples/_shared/tools/multimodal/fixtures.ts";
import {
  modes,
  digest,
  analysis,
  material,
  type Mode,
  type Material,
} from "../examples/_shared/tools/multimodal/domain.ts";
import {
  sandbox,
  models,
  mediaConfig,
} from "../examples/capabilities/multimodal/cli.ts";
import {
  runMultimodal,
  scope,
  memoryKey,
  type Report,
  type Options,
} from "../examples/capabilities/multimodal/shared.ts";
const { values } = parseArgs({
  options: {
    report: {
      type: "string",
      default: ".examples-multimodal-tasks-live-results.json",
    },
    "output-dir": { type: "string", default: ".examples-multimodal-tasks" },
  },
});
const config = loadRuntimeConfigFile("ditto.yaml", process.env),
  selected = models(config),
  mc = mediaConfig();
assert.ok(
  selected.visionModel,
  "Set DITTO_EXAMPLE_VISION_PROVIDER and DITTO_EXAMPLE_VISION_MODEL",
);
await mkdir(resolve(values["output-dir"]!), { recursive: true });
const directory = await mkdtemp(join(resolve(values["output-dir"]!), "run-")),
  results: Record<string, unknown>[] = [],
  startedAt = new Date().toISOString();
let reportWrites = Promise.resolve();
const cases = [
  ...modes.map((mode) => ({ name: mode + "-complete", mode })),
  ...modes.map((mode) => ({ name: mode + "-cache-expiry", mode })),
  ...[
    "redis-unavailable",
    "memory-unavailable",
    "source-missing",
    "source-changed",
    "source-symlink",
    "corrupt-pdf",
    "snapshot-resume",
    "input-changed",
    "wrong-citation",
    "publication-retry",
    "cancel-before-work",
    "material-crash",
    "analysis-crash",
    "publish-effect-crash",
  ].map((name) => ({ name, mode: "document-parsing" as Mode })),
  { name: "snapshot-image-tampered", mode: "image-understanding" as Mode },
  { name: "vision-not-configured", mode: "image-understanding" as Mode },
];
limitCapabilityCases(cases);
async function runCase(item: (typeof cases)[number]) {
  console.log(JSON.stringify({ name: item.name, event: "started" }));
  const dir = join(directory, item.name),
    r = await createFixture(dir, item.mode, mc.python),
    spans: { node: string; images: number }[] = [],
    children: { modelCalls: number; images: number }[] = [];
  let corrupt = false;
  function observed(d: WorkerDefinition): WorkerDefinition {
    return {
      ...d,
      instantiate() {
        const w = d.instantiate();
        return {
          async execute(node, input, context) {
            const text = JSON.stringify(input);
            spans.push({
              node,
              images: (text.match(/data:image\/jpeg;base64/g) ?? []).length,
            });
            const result = await w.execute(node, input, context);
            if (node === "INFER.REASONING.SAMPLE")
              await writeFile(
                join(dir, "model-response.json"),
                JSON.stringify(result, null, 2),
              );
            if (corrupt && node === "INFER.REASONING.SAMPLE") {
              const changed = structuredClone(result) as {
                output: { message: { content: string } };
              };
              const a = JSON.parse(
                changed.output.message.content
                  .trim()
                  .replace(/^```(?:json)?\s*/, "")
                  .replace(/\s*```$/, ""),
              );
              a.findings[0].quote = "fabricated nonexistent quote";
              changed.output.message.content = JSON.stringify(a);
              return changed;
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
        createInteractionWorker({ tools: mediaTools(dir, r, mc) }),
      ].map(observed),
    });
  let runtime = open();
  const entry = await import(`../examples/capabilities/multimodal/${r.mode}.ts`) as { run: typeof runMultimodal };
  const run = (options: Options = {}) =>
    entry.run(runtime, { request: r, ...selected }, options);
  const reopen = async () => {
    await runtime.close();
    await storage.close();
    storage = await openAgentStorage(dir, config);
    runtime = open();
  };
  const calls = () =>
    spans.filter((s) => s.node === "INFER.REASONING.SAMPLE").length +
    children.reduce((n, c) => n + c.modelCalls, 0);
  async function expire() {
    const key =
      (config.context.cache?.keyPrefix ?? "ditto:context:") +
      contextScopeKey(scope(r));
    await storage.redis.pExpire(key, 1);
    await delay(20);
    assert.equal(await storage.redis.get(key), null);
  }
  async function saved(stage: string) {
    const db = new DatabaseSync(join(dir, "memory.sqlite"));
    try {
      const row = db
        .prepare("SELECT content FROM memories WHERE memory_key=?")
        .get(memoryKey(r, stage)) as { content: string };
      return JSON.parse(row.content).value;
    } finally {
      db.close();
    }
  }
  async function absent() {
    assert.equal(
      await readFile(join(dir, "output/report.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
  }
  async function child(phase: string) {
    await new Promise<void>((done, reject) => {
      const p = spawn(
        process.execPath,
        [
          "scripts/fixtures/multimodal-child.ts",
          "--directory",
          dir,
          "--phase",
          phase,
        ],
        { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
      );
      let err = "";
      p.stderr.on("data", (v) => (err += String(v)));
      p.once("error", reject);
      p.once("exit", (code, signal) =>
        phase.endsWith("crash")
          ? signal === "SIGKILL"
            ? done()
            : reject(new Error(err || "Expected SIGKILL"))
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
    name: item.name,
    mode: item.mode,
    status: "failed",
    directory: dir,
  };
  try {
    if (item.name.endsWith("cache-expiry")) {
      await run({ stopAfter: "analysis" });
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
      case "source-changed":
      case "source-symlink":
      case "corrupt-pdf": {
        const s = r.sources[0]!,
          p = join(dir, s.path),
          original = await readFile(p),
          sha = s.sha256;
        await rm(p);
        if (item.name === "source-changed") await writeFile(p, "changed");
        if (item.name === "source-symlink") await symlink("/etc/hosts", p);
        if (item.name === "corrupt-pdf") {
          await writeFile(p, "Not a PDF");
          s.sha256 = digest("Not a PDF");
        }
        await assert.rejects(run());
        await absent();
        assert.equal(calls(), 0);
        await rm(p, { force: true });
        await writeFile(p, original);
        s.sha256 = sha;
        // The invalid task fingerprint is deliberately immutable; delete only the harness-owned failed input for a fresh retry.
        if (item.name === "corrupt-pdf") {
          const db = new DatabaseSync(join(dir, "memory.sqlite"));
          try {
            db.prepare("DELETE FROM memories WHERE memory_key=?").run(
              memoryKey(r, "input"),
            );
          } finally {
            db.close();
          }
        }
        break;
      }
      case "snapshot-resume":
        await run({ stopAfter: "material" });
        await writeFile(
          join(dir, r.sources[0]!.path),
          "changed after snapshot",
        );
        await expire();
        await reopen();
        break;
      case "input-changed":
        await run({ stopAfter: "material" });
        await assert.rejects(
          runMultimodal(runtime, {
            request: { ...r, instruction: "Changed task" },
            ...selected,
          }),
          /Request changed/,
        );
        break;
      case "wrong-citation":
        corrupt = true;
        await assert.rejects(run(), /quotation/);
        await absent();
        corrupt = false;
        break;
      case "publication-retry":
        await mkdir(join(dir, "output"));
        await writeFile(join(dir, "output/report.md"), "conflicting artifact");
        await assert.rejects(run(), /changed/);
        await rm(join(dir, "output/report.md"));
        await reopen();
        break;
      case "cancel-before-work":
        await assert.rejects(run({ signal: AbortSignal.abort() }));
        assert.equal(calls(), 0);
        await absent();
        break;
      case "material-crash":
      case "analysis-crash":
      case "publish-effect-crash":
        await child(item.name);
        await expire();
        await child("continue");
        break;
      case "snapshot-image-tampered": {
        await run({ stopAfter: "material" });
        const m = (await saved("material")) as Material,
          p = join(dir, m.sources[0]!.images[0]!.path),
          original = await readFile(p);
        await writeFile(p, "tampered");
        await assert.rejects(run(), /checksum/);
        assert.equal(calls(), 0);
        await absent();
        await writeFile(p, original);
        break;
      }
      case "vision-not-configured":
        await assert.rejects(
          runMultimodal(runtime, { request: r, model: selected.model }),
          /visionModel/,
        );
        assert.equal(calls(), 0);
        await absent();
        break;
    }
    const report = (await run()) as Report;
    assert.equal(report.mode, r.mode);
    const m = material(await saved("material"), r);
    analysis(report.analysis, r, m);
    const expected = JSON.parse(
        await readFile(join(dir, "expected.json"), "utf8"),
      ),
      d = report.analysis.data,
      body = JSON.stringify(report.analysis);
    if (r.mode === "document-parsing") {
      assert.match(body, /NimbusDesk/i);
      assert.ok(body.includes(String(expected.quota)));
      assert.ok(body.includes(String(expected.newQuota)));
      assert.equal(m.sources[0]!.blocks[0]!.location, "page:1");
      assert.equal(m.sources[1]!.blocks[0]!.location, "paragraph:1");
    }
    if (r.mode === "document-comparison") {
      assert.match(JSON.stringify(d.common), /NimbusDesk|2026-11-16/);
      const diff = JSON.stringify(d.differences);
      for (const n of [expected.quota, expected.newQuota, 30, 90])
        assert.ok(diff.includes(String(n)));
      assert.match(diff, /owner|Alice/i);
    }
    if (r.mode === "document-review") {
      const issues = d.issues as { rule: string; type: string }[];
      assert.ok(
        issues.some((i) => i.rule === "owner-required" && i.type === "missing"),
      );
      assert.ok(
        issues.some(
          (i) => i.rule === "retention-limit" && i.type === "violation",
        ),
      );
    }
    if (r.mode === "image-understanding") {
      const objects = d.objects as {
        shape: string;
        color: string;
        position: string;
      }[];
      assert.ok(
        objects.some(
          (o) =>
            /circle/i.test(o.shape) &&
            /blue/i.test(o.color) &&
            o.position === "left",
        ),
      );
      assert.ok(
        objects.some(
          (o) =>
            /square|rectangle/i.test(o.shape) &&
            /red/i.test(o.color) &&
            o.position === "right",
        ),
      );
      assert.equal(m.sources[0]!.blocks.length, 0);
    }
    if (r.mode === "chart-understanding") {
      const actual = Object.fromEntries(
        (d.series as { label: string; value: number }[]).map((s) => [
          s.label.slice(0, 3),
          s.value,
        ]),
      );
      assert.deepEqual(actual, expected.series);
      assert.equal(String(d.maximum).slice(0, 3), "Feb");
      assert.equal(d.change, expected.series.Mar - expected.series.Jan);
      const wrong = structuredClone(report.analysis);
      wrong.data.change = 999;
      assert.throws(() => analysis(wrong, r, m), /arithmetic/);
    }
    if (r.mode === "audio-transcription" || r.mode === "meeting-notes") {
      const transcript = String(m.sources[0]!.details.transcript);
      assert.match(transcript, /Alice/i);
      assert.match(transcript, /Bob/i);
      assert.match(transcript, /Friday/i);
      assert.ok((m.sources[0]!.details.segments as unknown[]).length);
      assert.equal(
        await readFile(join(dir, "output/source-1-transcript.txt"), "utf8"),
        transcript + "\n",
      );
      if (r.mode === "meeting-notes") {
        const actions = d.actions as {
          owner: string;
          due: string;
          task: string;
        }[];
        assert.ok(
          actions.some(
            (a) =>
              /Alice/i.test(a.owner) &&
              /Friday/i.test(a.due) &&
              /report/i.test(a.task),
          ),
        );
        assert.ok(
          actions.some(
            (a) =>
              /Bob/i.test(a.owner) &&
              /Thursday/i.test(a.due) &&
              /budget/i.test(a.task),
          ),
        );
        assert.match(JSON.stringify(d.decisions), /Monday/i);
      }
    }
    if (r.mode === "video-understanding") {
      assert.equal(m.sources[0]!.images.length, 3);
      assert.match(String(d.direction), /right/i);
      assert.ok(report.analysis.limitations.length);
      assert.equal(m.sources[0]!.details.audioAnalyzed, false);
    }
    for (const f of report.delivery.files) {
      const b = await readFile(join(dir, f.file));
      assert.equal(digest(b), f.sha256);
      assert.equal(b.length, f.bytes);
    }
    const before = calls();
    assert.deepEqual(await run(), report);
    assert.equal(calls(), before, "Completed task must not invoke model again");
    assert.equal(calls(), item.name === "wrong-citation" ? 2 : 1);
    Object.assign(record, {
      status: "passed",
      modelCalls: calls(),
      visionImages:
        spans
          .filter((s) => s.node === "INFER.REASONING.SAMPLE")
          .reduce((n, s) => n + s.images, 0) +
        children.reduce((n, c) => n + c.images, 0),
      engines: m.sources.map((s) => s.engine),
      artifacts: report.delivery.files,
    });
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    record.modelCalls = calls();
    results.push(record);
    await runtime.close();
    await storage.close();
    reportWrites = reportWrites.then(() =>
      writeFile(
        resolve(values.report!),
        JSON.stringify(
          {
            startedAt,
            directory,
            models: selected,
            storage: { context: "Redis", memory: "file SQLite" },
            results,
            passed: results.filter((r) => r.status === "passed").length,
            total: cases.length,
            modelCalls: results.reduce(
              (n, r) => n + Number(r.modelCalls ?? 0),
              0,
            ),
          },
          null,
          2,
        ),
      ),
    );
    await reportWrites;
    console.log(JSON.stringify(record));
  }
}
const queue = [...cases],
  errors: unknown[] = [];
async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    try {
      await runCase(item);
    } catch (e) {
      errors.push(e);
    }
  }
}
await Promise.all([worker(), worker()]);
if (errors.length)
  throw new AggregateError(errors, "Multimodal task experiments failed");
console.log(`Passed ${results.length} complete task and recovery experiments.`);
