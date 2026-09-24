/** Install the actual tarball outside the repository, check public types and run complete tasks. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { auditSource, sourceFiles } from "./lib/control-flow-boundary.ts";
const exec = promisify(execFile);
const root = process.cwd();
const app = await realpath(await mkdtemp(join(tmpdir(), "ditto-observation-consumer-")));
let guarded = false;
const env: NodeJS.ProcessEnv = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
async function run(command: string, args: string[], cwd = app) {
  try { return (await exec(command, args, { cwd, env: guarded ? { ...env, NODE_OPTIONS: `--import=${pathToFileURL(join(app, "boundary-hook.mjs")).href}` } : env, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout); throw error; }
}
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entries = Object.keys(manifest.exports).map(key => key === "." ? manifest.name : manifest.name + key.slice(1));
  const applicationFiles = [...await sourceFiles(join(root, "examples/capabilities/observation")), ...await sourceFiles(join(root, "examples/_shared/tools/observation")), ...await sourceFiles(join(root, "examples/_shared/tools/storage"))];
  for (const file of applicationFiles) auditSource(await readFile(file, "utf8"), file, entries);
  const storageDependencies = JSON.parse(await readFile(join(root, "examples/_shared/tools/storage/dependencies/package.json"), "utf8")).dependencies;
  const [packed] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], root));
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "observation-consumer", private: true, type: "module" }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(app, ".npm-cache"), join(app, packed.filename), `@types/node@${manifest.devDependencies["@types/node"]}`, `redis@${storageDependencies.redis}`]);
  await cp(join(root, "examples/capabilities/observation"), join(app, "examples/capabilities/observation"), { recursive: true });
  await cp(join(root, "examples/_shared/tools/observation"), join(app, "examples/_shared/tools/observation"), { recursive: true, filter: path => !path.split(/[\\/]/).includes("node_modules") });
  await cp(join(root, "examples/_shared/tools/storage"), join(app, "examples/_shared/tools/storage"), { recursive: true, filter: path => !path.split(/[\\/]/).includes("node_modules") });
  await cp(join(root, "scripts/check-examples-observation-tasks.ts"), join(app, "scripts/check-examples-observation-tasks.ts"), { recursive: true });
  await cp(join(root, "scripts/fixtures/observation-child.ts"), join(app, "scripts/fixtures/observation-child.ts"), { recursive: true });
  await cp(join(root, "scripts/lib/capability-cases.ts"), join(app, "scripts/lib/capability-cases.ts"), { recursive: true });
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, noEmit: true,
    types: ["node"], allowImportingTsExtensions: true,
  }, include: ["examples/**/*.ts", "scripts/**/*.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  assert.equal(await access(join(app, "node_modules/@ditto/core/src")).then(() => true, () => false), false);
  await writeFile(join(app, "boundary-hook.mjs"), `import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute, resolve } from "node:path";
const app = ${JSON.stringify(app)}, core = resolve(app, "node_modules/@ditto/core"), entries = new Set(${JSON.stringify(entries)});
function inside(root, path) { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\\\")); }
registerHooks({ resolve(specifier, observation, next) {
  if (specifier.startsWith("@ditto/core") && !entries.has(specifier)) throw new Error("Non-public Core entry");
  const result = next(specifier, observation);
  if (result.url.startsWith("file:")) {
    const path = fileURLToPath(result.url), parent = observation.parentURL?.startsWith("file:") ? fileURLToPath(observation.parentURL) : "";
    if (!inside(app, path)) throw new Error("Module outside consumer");
    if (inside(core, path) && !inside(core, parent) && !entries.has(specifier)) throw new Error("Core must be entered through public exports");
  }
  return result;
} });`);
  guarded = true;
  const probes = ["@ditto/core/src/index.ts", "@ditto/core/dist/runtime/index.js", pathToFileURL(join(root, "dist/index.js")).href];
  await run(process.execPath, ["--input-type=module", "-e", `for (const name of ${JSON.stringify(probes)}) { let blocked = false; try { await import(name); } catch { blocked = true; } if (!blocked) throw new Error("Boundary bypass"); }`]);
  const imports = ["read", "normalize", "errors", "state", "interpret"].map(name => `await import("./examples/capabilities/observation/${name}.ts");`).join("\n");
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", imports]), "");
  console.log("Installed tarball: strict public API types passed; module imports perform no work.");
  console.log(await run(process.execPath, ["scripts/check-examples-observation-tasks.ts", ...process.argv.slice(2),
    "--output-dir", join(root, ".examples-observation-tasks"), "--report", join(root, ".examples-observation-package-live-results.json")]));
  const reportPath = join(root, ".examples-observation-package-live-results.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.consumerChecks = { sourceFiles: applicationFiles.length, silentImports: 5, publicImportGuard: true, strictTypes: true, pathAliases: false, sourceTreePresent: false, tarballIntegrity: packed.integrity };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log("All observation task experiments passed against the installed npm package.");
} finally { await rm(app, { recursive: true, force: true }); }
