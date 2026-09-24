/** Install the actual tarball outside the repository, check public types and run complete tasks. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = process.cwd();
const app = await mkdtemp(join(tmpdir(), "ditto-recovery-consumer-"));
async function run(command: string, args: string[], cwd = app, timeout?: number) {
  try { return (await exec(command, args, { cwd, env: process.env, maxBuffer: 8 * 1024 * 1024, ...(timeout ? { timeout } : {}) })).stdout; }
  catch (error) { if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout); throw error; }
}
try {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const [packed] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], root));
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "recovery-consumer", private: true, type: "module" }));
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(app, packed.filename), `@types/node@${manifest.devDependencies["@types/node"]}`]);
  await cp(join(root, "examples/control-flow/recovery"), join(app, "examples/control-flow/recovery"), { recursive: true });
  for (const name of ["recovery-store.ts", "fulfillment-service.ts"]) await cp(join(root, "examples/_shared/tools", name), join(app, "examples/_shared/tools", name), { recursive: true });
  await cp(join(root, "scripts/fixtures/recovery-child.ts"), join(app, "scripts/fixtures/recovery-child.ts"), { recursive: true });
  await cp(join(root, "scripts/check-examples-recovery-tasks.ts"), join(app, "scripts/check-examples-recovery-tasks.ts"), { recursive: true });
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, noEmit: true,
    types: ["node"], allowImportingTsExtensions: true,
  }, include: ["examples/**/*.ts", "scripts/**/*.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  assert.equal(await access(join(app, "node_modules/@ditto/core/src")).then(() => true, () => false), false);
  const imports = ["retry", "fallback", "timeout", "checkpoint-resume", "pause-resume", "session-resume", "compensation", "side-effect-check"].map(name => `await import("./examples/control-flow/recovery/${name}.ts");`).join("\n");
  assert.equal(await run(process.execPath, ["--input-type=module", "-e", imports]), "");
  console.log("Installed tarball: strict public API types passed; module imports perform no work.");
  console.log(await run(process.execPath, ["scripts/check-examples-recovery-tasks.ts", ...process.argv.slice(2),
    "--output-dir", join(root, ".examples-recovery-tasks"), "--report", join(root, ".examples-recovery-package-live-results.json")]));
  // Exercise the executable module, including approval and reentry after an already persisted decision.
  const paused = JSON.parse(await run(process.execPath, ["examples/control-flow/recovery/pause-resume.ts"], app, 180_000));
  assert.equal(paused.checkpoint.stage, "paused");
  const savedCli = await mkdtemp(join(root, ".examples-recovery-tasks/package-cli-"));
  await cp(paused.directory, savedCli, { recursive: true });
  const approved = JSON.parse(await run(process.execPath, ["examples/control-flow/recovery/pause-resume.ts", "--directory", savedCli, "--decision", "approve", "--actor", "package-cli-operator"], app, 15_000));
  assert.equal(approved.checkpoint.stage, "completed");
  const reentered = JSON.parse(await run(process.execPath, ["examples/control-flow/recovery/pause-resume.ts", "--directory", savedCli], app, 15_000));
  assert.equal(reentered.checkpoint.stage, "completed");
  const reportPath = join(root, ".examples-recovery-package-live-results.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.cliPauseResume = { status: "passed", directory: savedCli, stages: [paused.checkpoint.stage, approved.checkpoint.stage, reentered.checkpoint.stage] };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log("Installed CLI pause, approval and completed-task reentry passed.");
  console.log("All recovery task experiments passed against the installed npm package.");
} finally { await rm(app, { recursive: true, force: true }); }
