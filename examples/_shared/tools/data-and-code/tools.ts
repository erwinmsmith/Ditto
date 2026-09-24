import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredTool } from "@ditto/core/worker/interaction";
import { immutable } from "../execution/files.ts";
import { isolatedCode, isolatedTests } from "../execution/docker.ts";
import {
  digest,
  json,
  object,
  material,
  plan,
  clean,
  metrics,
  profile,
  interpretation,
  testSummary,
  tools,
  isCode,
  type Request,
  type Material,
  type Plan,
  type Outcome,
} from "./domain.ts";
const exec = promisify(execFile);
export interface ToolConfig {
  python: string;
}
async function read(root: string, path: string, sha?: string) {
  const full = await realpath(resolve(root, path)),
    base = await realpath(root),
    rel = relative(base, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("File outside task root");
  const s = await stat(full);
  if (!s.isFile() || s.size > 256000)
    throw new Error("Invalid or oversized task file");
  const b = await readFile(full);
  if (sha && digest(b) !== sha) throw new Error("Source checksum mismatch");
  return b;
}
async function python(
  config: ToolConfig,
  script: string,
  input: unknown,
  signal?: AbortSignal,
) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      config.python,
      [fileURLToPath(new URL(script, import.meta.url))],
      {
        signal,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          MPLBACKEND: "Agg",
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (v) => {
      out += String(v);
      if (out.length > 100000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (v) => {
      err += String(v);
      if (err.length > 100000) child.kill("SIGKILL");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Media/data subprocess failed: ${err.slice(-1500)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
export function dataCodeTools(
  directory: string,
  r: Request,
  config: ToolConfig,
): RegisteredTool[] {
  const root = resolve(directory),
    snapshot = join(root, "snapshots"),
    out = join(root, "output"),
    effectDir = join(root, "effects");
  const receipt = async (file: string) => {
    const b = await read(root, file);
    return { file, sha256: digest(b), bytes: b.length };
  };
  const verify = async (m: Material) => {
    material(m, r);
    for (const f of m.files) await read(snapshot, f.path, f.sha256);
  };
  async function perform(
    p: Plan,
    m: Material,
    signal?: AbortSignal,
  ): Promise<Outcome> {
    plan(p, r, m);
    await verify(m);
    await mkdir(out, { recursive: true });
    await mkdir(effectDir, { recursive: true });
    const key = digest(JSON.stringify({ request: r, plan: p })),
      saved = join(effectDir, key + ".json");
    try {
      const o = JSON.parse(await readFile(saved, "utf8")) as Outcome;
      for (const f of o.files) await read(root, f.file, f.sha256);
      return o;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    let result: unknown,
      evidence: Record<string, unknown> = {
        sourceHashes: m.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      };
    const files: Outcome["files"] = [],
      args = p.arguments,
      rows = clean(m.rows ?? []).rows;
    const save = async (name: string, value: string | Uint8Array) => {
      await immutable(join(out, name), value);
      files.push(await receipt("output/" + name));
    };
    if (p.tool === "data_query") {
      const query = object(
        await python(
          config,
          "./sql.py",
          {
            path: join(snapshot, "business.sqlite"),
            sql: args.sql,
            parameters: args.parameters,
          },
          signal,
        ),
      );
      assert.deepEqual(
        query.rows,
        metrics(rows).byRegion,
        "Query does not answer the requested metric",
      );
      result = query;
      await save("query.sql", String(args.sql) + "\n");
      await save(
        "query.json",
        JSON.stringify(
          { parameters: args.parameters, rows: query.rows },
          null,
          2,
        ),
      );
    } else if (p.tool === "data_clean" || p.tool === "data_calculate") {
      const execution = await isolatedCode(
          String(args.code),
          { rows: p.tool === "data_clean" ? m.rows : rows },
          signal,
        ),
        expected = p.tool === "data_clean" ? rows : metrics(rows);
      assert.deepEqual(
        execution.output,
        expected,
        "Executed code failed independent business validation",
      );
      result =
        p.tool === "data_clean"
          ? { rows: execution.output, issues: clean(m.rows!).issues }
          : execution.output;
      evidence = {
        ...evidence,
        engine: "Docker Node.js",
        network: "none",
        hostMounts: false,
      };
      await save("program.js", String(args.code) + "\n");
      if (p.tool === "data_clean")
        await save(
          "cleaned.csv",
          "orderId,date,region,quantity,unitCents,status\n" +
            rows
              .map((r) =>
                [r.orderId, r.date, r.region, r.quantity, r.unitCents, r.status]
                  .map((v) => '"' + String(v).replaceAll('"', '""') + '"')
                  .join(","),
              )
              .join("\n") +
            "\n",
        );
    } else if (p.tool === "data_profile") result = profile(m.rows!, rows);
    else if (p.tool === "data_metrics") result = metrics(rows);
    else if (p.tool === "data_chart") {
      const regions = [...new Set(rows.map((r) => r.region))].sort(),
        series = regions.flatMap((region) =>
          ["paid", "pending", "refunded"].map((status) => ({
            region,
            status,
            revenueCents: rows
              .filter((r) => r.region === region && r.status === status)
              .reduce((s, r) => s + r.quantity * r.unitCents, 0),
          })),
        );
      const rendered = object(
        await python(config, "./plot.py", { directory: out, series }, signal),
      );
      result = { series, unit: "cents", displayUnit: "USD", chart: rendered };
      for (const name of ["chart.png", "chart.svg"])
        files.push(await receipt("output/" + name));
      await save("chart-data.json", JSON.stringify(series, null, 2));
    } else if (p.tool === "repository_search") {
      let stdout = "";
      try {
        stdout = (
          await exec(
            "rg",
            [
              "--line-number",
              "--fixed-strings",
              "--no-heading",
              "--color",
              "never",
              "--",
              String(args.query),
              ...m.files.map((f) => f.path),
            ],
            { cwd: snapshot, signal, timeout: 5000, maxBuffer: 65536 },
          )
        ).stdout;
      } catch (e) {
        if ((e as { code?: number }).code !== 1) throw e;
      }
      const matches = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = /^([^:]+):(\d+):(.*)$/.exec(line);
          if (!match) throw new Error("Invalid repository search output");
          return { path: match[1]!, line: Number(match[2]), text: match[3]! };
        });
      if (!matches.length) throw new Error("No repository matches");
      result = { query: args.query, matches };
    } else if (p.tool === "repository_tests" || p.tool === "code_patch") {
      const source = Object.fromEntries(
          m.files
            .filter((f) => f.path.endsWith(".mjs"))
            .map((f) => [f.path, f.content!]),
        ),
        baseline = await isolatedTests(source, signal),
        before = { ...baseline, summary: testSummary(baseline.stdout) };
      if (p.tool === "code_patch") {
        const tested = await isolatedTests(
          { ...source, "invoice.mjs": String(args.content) },
          signal,
        );
        const after = { ...tested, summary: testSummary(tested.stdout) };
        if (
          after.exitCode !== 0 ||
          !/^# tests 7$/m.test(after.stdout) ||
          !/^# pass 7$/m.test(after.stdout) ||
          !/^# fail 0$/m.test(after.stdout)
        )
          throw new Error(
            "Candidate failed protected tests: " + after.stdout.slice(-1200),
          );
        await save("baseline-tests.tap", before.stdout + before.stderr);
        await save("invoice.mjs", String(args.content));
        await save("invoice.test.mjs", source["invoice.test.mjs"]!);
        await save("tests.tap", after.stdout + after.stderr);
        result = {
          before,
          after,
          changedFile: "invoice.mjs",
          beforeSha256: args.expectedSha256,
          afterSha256: digest(String(args.content)),
          protectedTestSha256: digest(source["invoice.test.mjs"]!),
        };
      } else {
        await save("baseline-tests.tap", before.stdout + before.stderr);
        result = {
          tests: before,
          files: m.files
            .filter((f) => f.path.endsWith(".mjs"))
            .map((f) => ({ path: f.path, sha256: f.sha256 })),
          specification: r.instruction,
        };
      }
      evidence = {
        ...evidence,
        engine: "Docker Node.js test runner",
        network: "none",
        hostMounts: false,
        protectedTests: true,
      };
    } else throw new Error("Unknown operation");
    signal?.throwIfAborted();
    await save("result.json", JSON.stringify(result, null, 2) + "\n");
    const o: Outcome = {
      tool: p.tool,
      result: json(result),
      evidence: json(evidence) as Outcome["evidence"],
      files,
    };
    await immutable(saved, JSON.stringify(o));
    return o;
  }
  return [
    {
      name: "data_code_sources",
      effects: ["read", "write"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      validate(args) {
        if (Object.keys(args).length) throw new Error("No source arguments");
      },
      async execute(_args, context) {
        await mkdir(snapshot, { recursive: true });
        const files: Material["files"] = [];
        for (const f of r.sources) {
          context.signal?.throwIfAborted();
          const b = await read(root, f.path, f.sha256);
          await immutable(join(snapshot, f.path), b);
          files.push({
            ...f,
            ...(f.path.endsWith(".sqlite")
              ? {}
              : { content: b.toString("utf8") }),
          });
        }
        let data = {};
        if (!isCode(r.mode)) {
          const { stdout } = await exec(
            config.python,
            [
              fileURLToPath(new URL("./inspect_dataset.py", import.meta.url)),
              snapshot,
            ],
            {
              signal: context.signal,
              timeout: 10000,
              maxBuffer: 65536,
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
            },
          );
          data = object(JSON.parse(stdout));
        }
        return {
          status: "success",
          structuredContent: json(material({ files, ...data }, r)),
        };
      },
    },
    {
      name: tools[r.mode],
      effects: ["read", "write", "execute"],
      inputSchema: {
        type: "object",
        required: ["plan", "material"],
        properties: { plan: { type: "object" }, material: { type: "object" } },
        additionalProperties: false,
      },
      validate(args) {
        plan(args.plan, r, material(args.material, r));
      },
      async execute(args, context) {
        return {
          status: "success",
          structuredContent: json(
            await perform(
              plan(args.plan, r, material(args.material, r)),
              args.material as unknown as Material,
              context.signal,
            ),
          ),
        };
      },
    },
    {
      name: "data_code_publish",
      effects: ["read", "write"],
      inputSchema: {
        type: "object",
        required: ["material", "outcome", "interpretation"],
        properties: {
          material: { type: "object" },
          outcome: { type: "object" },
          interpretation: { type: "object" },
        },
        additionalProperties: false,
      },
      validate(args) {
        interpretation(
          args.interpretation,
          r,
          material(args.material, r),
          args.outcome as unknown as Outcome,
        );
      },
      async execute(args, context) {
        const m = material(args.material, r),
          o = args.outcome as unknown as Outcome,
          a = interpretation(args.interpretation, r, m, o);
        await verify(m);
        for (const f of o.files) await read(root, f.file, f.sha256);
        context.signal?.throwIfAborted();
        const report = {
            taskId: r.id,
            mode: r.mode,
            interpretation: a,
            outcome: o,
          },
          md =
            `# ${r.mode}\n\n${a.summary}\n\n` +
            a.insights
              .map(
                (i) =>
                  "- " +
                  i.text +
                  "\n  " +
                  i.evidence
                    .map((e) => e.pointer + " = " + JSON.stringify(e.value))
                    .join("; "),
              )
              .join("\n") +
            "\n\n" +
            a.issues
              .map(
                (i) =>
                  `- ${i.severity}: ${i.path}:${i.line} — ${i.reason}\n  Fix: ${i.fix}`,
              )
              .join("\n") +
            "\n\n" +
            a.limitations.map((s) => "- " + s).join("\n") +
            "\n";
        await immutable(
          join(out, "report.json"),
          JSON.stringify(report, null, 2) + "\n",
        );
        await immutable(join(out, "report.md"), md);
        return {
          status: "success",
          structuredContent: json({
            files: [
              await receipt("output/report.json"),
              await receipt("output/report.md"),
              ...o.files,
            ],
          }),
        };
      },
    },
  ];
}
