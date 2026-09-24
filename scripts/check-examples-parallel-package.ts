/** Install the actual tarball outside the repository, check public types and run complete tasks. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = process.cwd();
const app = await mkdtemp(join(tmpdir(), "ditto-parallel-consumer-"));
async function run(command: string, args: string[], cwd = app) {
  try { return (await exec(command, args, { cwd, env: process.env, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout); throw error; }
}
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const [packed] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], root));
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "parallel-consumer", private: true, type: "module" }));
  const [retrievalPacked] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], join(root, "packages/retrieval")));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(app, packed.filename), join(app, retrievalPacked.filename), `@types/node@${manifest.devDependencies["@types/node"]}`]);
  await cp(join(root, "examples/control-flow/parallel"), join(app, "examples/control-flow/parallel"), { recursive: true });
  await cp(join(root, "examples/_shared/tools/order-files.ts"), join(app, "examples/_shared/tools/order-files.ts"), { recursive: true });
  await cp(join(root, "scripts/check-examples-parallel-tasks.ts"), join(app, "scripts/check-examples-parallel-tasks.ts"), { recursive: true });
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, noEmit: true,
    types: ["node"], allowImportingTsExtensions: true,
  }, include: ["examples/**/*.ts", "scripts/**/*.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  assert.equal(await access(join(app, "node_modules/@codesoul-co/ditto/src")).then(() => true, () => false), false);
  const imports = ["concurrency-limit", "planning", "fan-out-fan-in", "partial-results"].map(name => `await import("./examples/control-flow/parallel/${name}.ts");`).join("\n");
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", imports]), "");
  console.log("Installed tarball: strict public API types passed; module imports perform no work.");
  console.log(await run(process.execPath, ["scripts/check-examples-parallel-tasks.ts", ...process.argv.slice(2),
    "--output-dir", join(root, ".examples-parallel-tasks"), "--report", join(root, ".examples-parallel-package-live-results.json")]));
  console.log("All parallel task experiments passed against the installed npm package.");
} finally { await rm(app, { recursive: true, force: true }); }
