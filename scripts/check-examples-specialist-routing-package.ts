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
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { auditSource, sourceFiles } from "./lib/control-flow-boundary.ts";
const exec = promisify(execFile);
const root = process.cwd();
const reportIndex = process.argv.indexOf("--report");
const reportPath =
  reportIndex >= 0
    ? resolve(process.argv[reportIndex + 1]!)
    : join(root, ".examples-specialist-routing-package-live-results.json");
const app = await realpath(
  await mkdtemp(join(tmpdir(), "ditto-specialist-routing-consumer-")),
);
let guarded = false;
const env = { ...process.env };
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
    ...(await sourceFiles(join(root, "examples/patterns/specialist-routing"))),
    ...(await sourceFiles(
      join(root, "examples/_shared/tools/specialist-routing"),
    )),
    ...(await sourceFiles(join(root, "examples/_shared/tools/storage"))),
    join(root, "examples/_shared/tools/execution/files.ts"),
    join(root, "examples/_shared/tools/evidence.ts"),
  ];
  for (const file of applicationFiles)
    auditSource(await readFile(file, "utf8"), file, entries);
  const webEntry = await readFile(
    join(root, "examples/patterns/specialist-routing/index.ts"),
    "utf8",
  );
  assert.match(webEntry, /runtime\.loop\(\s*runSpecialistRoutingLoop/);
  assert.ok(webEntry.includes("yield* graphStep("));
  assert.ok(
    !/\bruntime\.run\s*\(/.test(webEntry),
    "SpecialistRouting plans must yield Graphs to Loop",
  );
  await cp(
    join(root, "examples/_shared/tools/evidence.ts"),
    join(app, "examples/_shared/tools/evidence.ts"),
    { recursive: true },
  );
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
      name: "specialist-routing-consumer",
      private: true,
      type: "module",
    }),
  );
  const [retrievalPacked] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], join(root, "packages/retrieval")));
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    join(app, ".npm-cache"),
    join(app, packed.filename), join(app, retrievalPacked.filename),
    `@types/node@${manifest.devDependencies["@types/node"]}`,
    `redis@${storageDependencies.redis}`,
  ]);
  await cp(
    join(root, "examples/patterns/specialist-routing"),
    join(app, "examples/patterns/specialist-routing"),
    { recursive: true },
  );
  await cp(
    join(root, "examples/_shared/tools/specialist-routing"),
    join(app, "examples/_shared/tools/specialist-routing"),
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
    join(root, "scripts/check-examples-specialist-routing-tasks.ts"),
    join(app, "scripts/check-examples-specialist-routing-tasks.ts"),
    { recursive: true },
  );
  await cp(
    join(root, "scripts/fixtures/specialist-routing-child.ts"),
    join(app, "scripts/fixtures/specialist-routing-child.ts"),
    { recursive: true },
  );
  await cp(
    join(root, "examples/_shared/tools/execution/files.ts"),
    join(app, "examples/_shared/tools/execution/files.ts"),
    { recursive: true },
  );
  for (const file of ["scripts/fixtures/specialist-routing-runtime.ts"]) {
    await cp(join(root, file), join(app, file), { recursive: true });
  }
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  const docs = await readFile(
    join(root, "docs/worker-api/specialist-routing-workflows.md"),
    "utf8",
  );
  const snippet = /```ts\n([\s\S]*?)\n```/.exec(docs)?.[1];
  assert.ok(snippet);
  await writeFile(join(app, "specialist-routing-client.ts"), snippet);
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
        "specialist-routing-client.ts",
      ],
    }),
  );
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  assert.equal(
    await access(join(app, "node_modules/@codesoul-co/ditto/src")).then(
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
const app = ${JSON.stringify(app)}, core = resolve(app, "node_modules/@codesoul-co/ditto"), entries = new Set([...${JSON.stringify(entries)}, "@codesoul-co/ditto-retrieval", "@codesoul-co/ditto-retrieval/adapters/memory", "@codesoul-co/ditto-retrieval/adapters/context"]);
function inside(root, path) { const r = relative(root, path); return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith("../") && !r.startsWith("..\\\\")); }
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@codesoul-co/ditto") && !entries.has(specifier)) throw new Error("Non-public Core entry");
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
    "@codesoul-co/ditto/src/index.ts",
    "@codesoul-co/ditto/dist/runtime/index.js",
    pathToFileURL(join(root, "dist/index.js")).href,
    pathToFileURL(join(app, "node_modules/@codesoul-co/ditto/dist/index.js")).href,
  ];
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    `for (const name of ${JSON.stringify(probes)}) { let blocked = false; try { await import(name); } catch { blocked = true; } if (!blocked) throw new Error("Boundary bypass"); }`,
  ]);
  const imports =
    ["index", "cli"]
      .map(
        (name) =>
          `await import("./examples/patterns/specialist-routing/${name}.ts");`,
      )
      .join("\n") +
    'await import("./examples/_shared/tools/specialist-routing/adapters.ts"); await import("./examples/_shared/tools/specialist-routing/domain.ts");';
  assert.equal(
    await run(process.execPath, ["--input-type=module", "-e", imports]),
    "",
  );
  console.log(
    "Installed tarball: strict public API types passed; module imports perform no work.",
  );
  if (process.argv.includes("--types-only")) process.exitCode = 0;
  else {
    const docsOnly = process.argv.includes("--docs-only");
    if (!docsOnly)
      console.log(
        await run(process.execPath, [
          "scripts/check-examples-specialist-routing-tasks.ts",
          ...process.argv.slice(2),
          "--output-dir",
          join(root, ".examples-specialist-routing-tasks"),
          "--report",
          reportPath,
        ]),
      );
    const report = docsOnly
      ? { results: [] }
      : JSON.parse(await readFile(reportPath, "utf8"));
    const providerIndex = process.argv.indexOf("--provider");
    if (providerIndex >= 0)
      env.EXAMPLE_SPECIALIST_ROUTING_PROVIDER =
        process.argv[providerIndex + 1]!;
    try {
      const documented = JSON.parse(
        await run(process.execPath, ["specialist-routing-client.ts"]),
      );
      assert.equal(documented.status, "completed");
      assert.equal(documented.route.selected, "data");
      assert.equal(documented.answer.values.revenueCents, 240000);
      assert.equal(documented.answer.values.paidOrders, 3);
      report.documentationExample = { status: "passed", realModel: true };
    } catch (error) {
      report.documentationExample = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      throw error;
    }
    report.consumerChecks = {
      sourceFiles: applicationFiles.length,
      silentImports: 4,
      publicImportGuard: true,
      strictTypes: true,
      pathAliases: false,
      sourceTreePresent: false,
      tarballIntegrity: packed.integrity,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(
      docsOnly
        ? "The documented SpecialistRouting consumer passed against the installed npm package."
        : "Selected SpecialistRouting tasks and the documented consumer passed against the installed npm package.",
    );
  }
} finally {
  await rm(app, { recursive: true, force: true });
}
