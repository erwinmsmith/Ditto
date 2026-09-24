/** Install the actual tarball outside the repository, check public types and run complete tasks. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { auditSource, sourceFiles } from "./lib/control-flow-boundary.ts";
const exec = promisify(execFile);
const root = process.cwd();
const app = await realpath(
  await mkdtemp(join(tmpdir(), "ditto-validation-consumer-")),
);
let guarded = false;
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
async function run(command: string, args: string[], cwd = app) {
  try {
    return (
      await exec(command, args, {
        cwd,
        env: guarded
          ? {
              ...env,
              NODE_OPTIONS: `--import=${pathToFileURL(join(app, "boundary-hook.mjs")).href}`,
            }
          : env,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error)
      console.error(error.stdout);
    throw error;
  }
}
try {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const entries = Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : manifest.name + key.slice(1),
  );
  const applicationFiles = [
    ...(await sourceFiles(join(root, "examples/capabilities/validation"))),
    ...(await sourceFiles(join(root, "examples/_shared/tools/validation"))),
    ...(await sourceFiles(join(root, "examples/_shared/tools/storage"))),
    ...(await sourceFiles(join(root, "examples/_shared/tools/execution"))),
  ];
  for (const file of applicationFiles)
    auditSource(await readFile(file, "utf8"), file, entries);
  const storageDependencies = JSON.parse(
    await readFile(
      join(root, "examples/_shared/tools/storage/dependencies/package.json"),
      "utf8",
    ),
  ).dependencies;
  const [packed] = JSON.parse(
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", app],
      root,
    ),
  );
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "validation-consumer",
      private: true,
      type: "module",
    }),
  );
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    join(app, ".npm-cache"),
    join(app, packed.filename),
    `@types/node@${manifest.devDependencies["@types/node"]}`,
    `redis@${storageDependencies.redis}`,
  ]);
  await cp(
    join(root, "examples/capabilities/validation"),
    join(app, "examples/capabilities/validation"),
    { recursive: true },
  );
  await cp(
    join(root, "examples/_shared/tools/validation"),
    join(app, "examples/_shared/tools/validation"),
    {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
    },
  );
  await cp(
    join(root, "examples/_shared/tools/execution"),
    join(app, "examples/_shared/tools/execution"),
    { recursive: true },
  );
  await cp(
    join(root, "examples/_shared/tools/storage"),
    join(app, "examples/_shared/tools/storage"),
    {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
    },
  );
  await cp(
    join(root, "scripts/check-examples-validation-tasks.ts"),
    join(app, "scripts/check-examples-validation-tasks.ts"),
    { recursive: true },
  );
  await cp(
    join(root, "scripts/fixtures/validation-child.ts"),
    join(app, "scripts/fixtures/validation-child.ts"),
    { recursive: true },
  );
  await cp(join(root, "scripts/lib/capability-cases.ts"), join(app, "scripts/lib/capability-cases.ts"), { recursive: true });
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  const apiDocument = await readFile(
    join(root, "docs/worker-api/validation-workflows.md"),
    "utf8",
  );
  const snippet = apiDocument.split("```ts\n")[1]!.split("```")[0]!;
  await writeFile(join(app, "validation-doc-check.ts"), snippet);

  await writeFile(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        noEmit: true,
        types: ["node"],
        allowImportingTsExtensions: true,
      },
      include: [
        "examples/**/*.ts",
        "scripts/**/*.ts",
        "validation-doc-check.ts",
      ],
    }),
  );
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  assert.equal(
    await access(join(app, "node_modules/@ditto/core/src")).then(
      () => true,
      () => false,
    ),
    false,
  );
  await writeFile(
    join(app, "boundary-hook.mjs"),
    `import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { relative, isAbsolute, resolve } from "node:path";
const app = ${JSON.stringify(app)}, core = resolve(app, "node_modules/@ditto/core"), entries = new Set(${JSON.stringify(entries)});
function inside(root, path) { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\\\")); }
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@ditto/core") && !entries.has(specifier)) throw new Error("Non-public Core entry");
  const result = next(specifier, context);
  if (result.url.startsWith("file:")) {
    const path = fileURLToPath(result.url), parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : "";
    if (!inside(app, path)) throw new Error("Module outside consumer");
    if (inside(core, path) && !inside(core, parent) && !entries.has(specifier)) throw new Error("Core must be entered through public exports");
  }
  return result;
} });`,
  );
  guarded = true;
  const probes = [
    "@ditto/core/src/index.ts",
    "@ditto/core/dist/runtime/index.js",
    pathToFileURL(join(root, "dist/index.js")).href,
  ];
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(probes)}) { let blocked = false; try { await import(name); } catch { blocked = true; } if (!blocked) throw new Error("Boundary bypass"); }`,
  ]);
  const imports = [
    "schema",
    "evaluate",
    "consistency",
    "permissions",
    "risk",
    "policy",
    "input-safety",
    "sensitive-data",
    "redaction",
  ]
    .map(
      (name) =>
        `await import("./examples/capabilities/validation/${name}.ts");`,
    )
    .join("\n");
  assert.equal(
    await run(process.execPath, ["--input-type=module", "-e", imports]),
    "",
  );
  console.log(
    "Installed tarball: strict public API types passed; module imports perform no work.",
  );
  console.log(
    await run(process.execPath, [
      "scripts/check-examples-validation-tasks.ts",
      ...process.argv.slice(2),
      "--output-dir",
      join(root, ".examples-validation-tasks"),
      "--report",
      join(root, ".examples-validation-package-live-results.json"),
    ]),
  );
  const reportPath = join(
    root,
    ".examples-validation-package-live-results.json",
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const modes = [
    "schema",
    "evaluate",
    "consistency",
    "permissions",
    "risk",
    "policy",
    "input-safety",
    "sensitive-data",
    "redaction",
  ];
  for (const mode of modes) {
    const output = JSON.parse(
      await run(process.execPath, [
        `examples/capabilities/validation/${mode}.ts`,
        "--directory",
        join(report.directory, mode + "-complete"),
      ]),
    );
    assert.equal(output.result.mode, mode);
    const expected = report.results.find(
      (r: { name: string }) => r.name === mode + "-complete",
    );
    assert.equal(output.result.receipt.status, expected.status);
  }
  const documentOutput = await run(process.execPath, [
    "validation-doc-check.ts",
  ]);
  assert.ok(documentOutput.includes("confirmation-required"));
  report.consumerChecks = {
    entryExecutions: modes.length,
    documentationExample: {
      strictTypes: true,
      executed: true,
      realModelCalls: 1,
    },
    sourceFiles: applicationFiles.length,
    silentImports: 9,
    publicImportGuard: true,
    strictTypes: true,
    pathAliases: false,
    sourceTreePresent: false,
    tarballIntegrity: packed.integrity,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    "All validation task experiments passed against the installed npm package.",
  );
} finally {
  await rm(app, { recursive: true, force: true });
}
