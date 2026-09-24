/** Audit every control-flow example against one installed tarball with no repository module access. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { auditControlFlows, controlFlows, type Category } from "./lib/control-flow-boundary.ts";
const { values } = parseArgs({ options: { category: { type: "string" }, provider: { type: "string" }, "types-only": { type: "boolean" }, python: { type: "string" }, report: { type: "string", default: ".examples-control-flow-package-live-results.json" } } });
const root = process.cwd(), audit = await auditControlFlows(root);
const categories = values.category ? values.category.split(",") : [...audit.categories];
assert.ok(categories.length && new Set(categories).size === categories.length && categories.every(category => category in controlFlows), "Choose distinct supported categories");
const selected = categories as Category[];
const exec = promisify(execFile), app = await realpath(await mkdtemp(join(tmpdir(), "ditto-control-flow-consumer-")));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const baseEnv = { ...process.env }; delete baseEnv.NODE_PATH; delete baseEnv.NODE_OPTIONS;
async function run(command: string, args: string[], cwd = app, guarded = false) {
  try { return (await exec(command, args, { cwd, env: guarded ? { ...baseEnv, NODE_OPTIONS: `--import=${pathToFileURL(join(app, "boundary-hook.mjs")).href}` } : baseEnv, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch (error) { if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout); throw error; }
}
const results: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: "running", audit, selected, packagePublishEnabled: manifest.private !== true, results };
const save = () => writeFile(resolve(values.report!), JSON.stringify(report, null, 2) + "\n");
await save();
try {
  const [packed] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], root));
  assert.ok(packed.files.every((file: { path: string }) => file.path === "package.json" || ["README.md", "README.zh-CN.md"].includes(file.path) || file.path.startsWith("dist/")), "Unexpected source, example or secret in tarball");
  report.tarball = { filename: packed.filename, integrity: packed.integrity, shasum: packed.shasum, files: packed.files.length };
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "control-flow-consumer", private: true, type: "module" }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(app, packed.filename), `@types/node@${manifest.devDependencies["@types/node"]}`, `typescript@${manifest.devDependencies.typescript}`]);
  for (const directory of ["examples/control-flow", "examples/_shared/tools", "scripts/fixtures"]) await cp(join(root, directory), join(app, directory), { recursive: true, filter: path => !path.split(/[\\/]/).some(part => [".venv", "__pycache__", "node_modules", "understanding-child.ts", "planning-child.ts", "retrieval-child.ts", "analysis-child.ts", "context-child.ts", "memory-child.ts", "operations-child.ts", "observation-child.ts", "content-child.ts", "multimodal-child.ts", "data-code-child.ts", "validation-child.ts", "rag-child.ts", "web-search-child.ts", "web-search-runtime.ts", "web-search-http.ts", "research-child.ts", "research-runtime.ts", "research-http.ts", "react-child.ts", "react-runtime.ts", "plan-execute-child.ts", "plan-execute-runtime.ts", "reflection-child.ts", "reflection-runtime.ts", "candidates-child.ts", "candidates-runtime.ts", "tool-chain-child.ts", "tool-chain-runtime.ts", "human-loop-child.ts", "human-loop-runtime.ts", "multi-agent-child.ts", "multi-agent-runtime.ts", "supervisor-child.ts", "supervisor-runtime.ts", "handoff-child.ts", "handoff-runtime.ts", "specialist-routing-child.ts", "specialist-routing-runtime.ts", "debate-child.ts", "debate-runtime.ts", "auto-repair-runtime.ts", "auto-repair-child.ts", "long-running-child.ts", "long-running-runtime.ts"].includes(part)) });
  for (const category of Object.keys(controlFlows)) {
    const script = `check-examples-${category}-${category === "sequence" ? "live" : "tasks"}.ts`;
    await cp(join(root, "scripts", script), join(app, "scripts", script));
  }
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true, verbatimModuleSyntax: true,
    erasableSyntaxOnly: true, noEmit: true, types: ["node"], allowImportingTsExtensions: true,
  }, include: ["examples/**/*.ts", "scripts/**/*.ts"] }));
  await run(join(app, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  for (const path of ["src", "node_modules/@ditto/core/src", ".env"]) assert.equal(await access(join(app, path)).then(() => true, () => false), false, `Consumer must not contain ${path}`);
  // The hook is inherited by task subprocesses. It allows only this consumer's modules,
  // and only exported specifiers when application code enters the installed Core package.
  await writeFile(join(app, "boundary-hook.mjs"), `import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
const app = ${JSON.stringify(app)}, core = resolve(app, "node_modules/@ditto/core"), entries = new Set(${JSON.stringify(audit.publicEntries)});
function inside(root, path) { const rest = relative(root, path); return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith("../") && !rest.startsWith("..\\\\")); }
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@ditto/core") && !entries.has(specifier)) throw new Error("Non-public Core entry: " + specifier);
  const result = next(specifier, context);
  if (result.url.startsWith("file:")) {
    const path = fileURLToPath(result.url);
    if (!inside(app, path)) throw new Error("Module outside installed consumer: " + path);
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : "";
    if (inside(core, path) && !inside(core, parent) && !entries.has(specifier)) throw new Error("Core must be entered through its exports: " + specifier);
  }
  return result;
} });
`);
  // Negative checks prove the guard is active, including for absolute repository file URLs.
  const probes = ["@ditto/core/src/index.ts", "@ditto/core/dist/runtime/runtime.js", pathToFileURL(join(root, "dist/index.js")).href, pathToFileURL(join(app, "node_modules/@ditto/core/dist/runtime/index.js")).href];
  await run(process.execPath, ["--input-type=module", "-e", `for (const name of ${JSON.stringify(probes)}) { let blocked = false; try { await import(name); } catch { blocked = true; } if (!blocked) throw new Error("Boundary was bypassed: " + name); }`], app, true);
  const imports = Object.entries(controlFlows).flatMap(([category, names]) => names.map(name => `await import("./examples/control-flow/${category}/${name}.ts");`)).join("\n");
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", imports], app, true), "", "Importing examples must not execute them");
  report.consumerChecks = { strictTypes: true, pathAliases: false, sourceTreePresent: false, credentialFileCopied: false, importGuard: true, negativeProbes: probes.length, silentImports: audit.examples };
  await save(); console.log(`One tarball: ${audit.categories.length} categories, ${audit.examples} imports and strict public types passed.`);
  if (!values["types-only"]) for (const category of selected) {
    const script = `check-examples-${category}-${category === "sequence" ? "live" : "tasks"}.ts`;
    const reportPath = join(root, `.examples-control-flow-${category}-live-results.json`);
    const args = ["scripts/" + script, ...(values.provider ? ["--provider", values.provider] : []), "--report", reportPath,
      ...(category === "sequence" ? [] : ["--output-dir", join(root, `.examples-${category}-tasks`)]),
      ...(category === "routing" ? ["--python", resolve(values.python ?? process.env.DITTO_EXAMPLE_TOOLS_PYTHON ?? join(root, "examples/_shared/tools/.venv/bin/python"))] : []),
    ];
    const started = Date.now(); console.log(`${category}: task acceptance started`);
    try {
      await run(process.execPath, args, app, true);
      const taskReport = JSON.parse(await readFile(reportPath, "utf8"));
      assert.ok(taskReport.results.length && taskReport.results.every((row: { status: string }) => row.status === "passed"));
      const result = { category, status: "passed", scenarios: taskReport.results.length, modelCalls: taskReport.results.reduce((n: number, row: { modelCalls?: number }) => n + (row.modelCalls ?? 0), 0), report: reportPath, durationMs: Date.now() - started };
      results.push(result); console.log(JSON.stringify(result));
    } catch (error) { results.push({ category, status: "failed", report: reportPath, error: error instanceof Error ? error.message : "Acceptance failed", durationMs: Date.now() - started }); throw error; }
    finally { await save(); }
  }
  report.status = "passed"; report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ status: report.status, examples: audit.examples, categories: selected, report: resolve(values.report!) }, null, 2));
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : "Package validation failed"; await save(); throw error; }
finally { await rm(app, { recursive: true, force: true }); }
