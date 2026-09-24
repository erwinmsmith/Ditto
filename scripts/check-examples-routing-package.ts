/** Verify copied examples as an external npm consumer, then run the real-model suite there. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();
const taskMode = process.argv.includes("--tasks");
const checkScript = taskMode ? "check-examples-routing-tasks.ts" : "check-examples-routing-live.ts";
const app = await mkdtemp(join(tmpdir(), "ditto-routing-consumer-"));
const run = async (command: string, args: string[], cwd = app) => {
  try {
    const result = await exec(command, args, { cwd, maxBuffer: 8 * 1024 * 1024, env: process.env });
    return result.stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout);
    throw error;
  }
};
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const [packed] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], root));
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "routing-consumer", private: true, type: "module" }));
  const [retrievalPacked] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], join(root, "packages/retrieval")));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(app, packed.filename), join(app, retrievalPacked.filename), `@types/node@${manifest.devDependencies["@types/node"]}`]);
  const examples = ["state-routing", "conditional", "branch-merge", "file-type", "risk", "confidence"];
  await cp(join(root, "examples/control-flow/routing"), join(app, "examples/control-flow/routing"), { recursive: true });
  await cp(join(root, "examples/_shared/tools"), join(app, "examples/_shared/tools"), { recursive: true, filter: source => !source.split(/[\\/]/).some(part => part === ".venv" || part === "__pycache__") });
  await cp(join(root, "scripts", checkScript), join(app, "scripts", checkScript), { recursive: true });
  if (taskMode) await cp(join(root, "scripts/fixtures"), join(app, "scripts/fixtures"), { recursive: true });
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true,
    erasableSyntaxOnly: true, noEmit: true, types: ["node"], allowImportingTsExtensions: true,
  }, include: ["examples/**/*.ts", "scripts/**/*.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  const sourceExists = await access(join(app, "node_modules/@codesoul-co/ditto/src")).then(() => true, () => false);
  assert.equal(sourceExists, false, "Consumer must resolve the published dist exports");
  const imports = examples.map(name => `await import(${JSON.stringify(`./examples/control-flow/routing/${name}.ts`)});`).join("\n");
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", imports]), "", "Imports must not execute examples");
  console.log("Installed tarball: public exports and strict consumer types passed; imports perform no work.");
  // No credential files are copied. Provider secrets remain in the explicitly loaded process environment.
  const live = await run(process.execPath, ["scripts/" + checkScript, ...process.argv.slice(2).filter(arg => arg !== "--tasks"),
    ...(taskMode ? ["--python", process.env.DITTO_EXAMPLE_TOOLS_PYTHON ?? join(root, "examples/_shared/tools/.venv/bin/python"), "--output-dir", join(root, ".examples-routing-tasks")] : []),
    "--report", resolve(root, taskMode ? ".examples-routing-tasks-package-live-results.json" : ".examples-routing-package-live-results.json")]);
  console.log(live);
  console.log("All routing examples passed against the installed npm tarball.");
} finally { await rm(app, { recursive: true, force: true }); }
