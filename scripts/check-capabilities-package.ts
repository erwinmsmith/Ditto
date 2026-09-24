/** Audit Agent capabilities against installed Core and optional retrieval tarballs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  auditCapabilities,
  capabilities,
  suiteName,
  type Capability,
} from "./lib/capability-boundary.ts";
const { values } = parseArgs({
  options: {
    category: { type: "string" },
    coverage: { type: "string", default: "complete" },
    "types-only": { type: "boolean" },
    "memory-backend": { type: "string" },
    report: {
      type: "string",
      default: ".examples-capabilities-package-live-results.json",
    },
  },
});
const root = process.cwd(),
  audit = await auditCapabilities(root),
  selected = (
    values.category ? values.category.split(",") : Object.keys(capabilities)
  ) as Capability[];
assert.ok(
  selected.length &&
    new Set(selected).size === selected.length &&
    selected.every((c) => c in capabilities),
  "Choose distinct capability categories",
);
if (values["memory-backend"])
  assert.ok(
    ["sqlite", "postgres", "qdrant"].includes(values["memory-backend"]),
  );
assert.ok(["complete", "capabilities"].includes(values.coverage!));
const exec = promisify(execFile),
  app = await realpath(
    await mkdtemp(join(tmpdir(), "ditto-capabilities-consumer-")),
  ),
  env: NodeJS.ProcessEnv = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
env.DITTO_EXAMPLE_CAPABILITY_COVERAGE = values.coverage!;
for (const key of [
  "DITTO_EXAMPLE_TOOLS_PYTHON",
  "DITTO_EXAMPLE_MEDIA_PYTHON",
  "DITTO_EXAMPLE_DATA_PYTHON",
])
  env[key] ??= join(root, "examples/_shared/tools/.venv/bin/python");
const results: Record<string, unknown>[] = [],
  report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    status: "running",
    coverage: values.coverage,
    audit,
    selected,
    results,
  };
let reportWrites = Promise.resolve();
const save = () =>
  (reportWrites = reportWrites.then(() =>
    writeFile(resolve(values.report!), JSON.stringify(report, null, 2) + "\n"),
  ));
await mkdir(join(root, ".examples-capabilities-tasks"), { recursive: true });
const output = await mkdtemp(join(root, ".examples-capabilities-tasks/run-"));
report.output = output;
async function run(
  command: string,
  args: string[],
  guarded = false,
  cwd = app,
) {
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
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch (e) {
    if (e && typeof e === "object" && "stdout" in e) console.error(e.stdout);
    throw e;
  }
}
await save();
try {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  report.packagePublishEnabled = manifest.private !== true;
  const [packed] = JSON.parse(
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", app],
      false,
      root,
    ),
  );
  assert.ok(
    packed.files.every(
      (f: { path: string }) =>
        ["package.json", "README.md", "README.zh-CN.md"].includes(f.path) ||
        f.path.startsWith("dist/"),
    ),
    "Unexpected source or secret in tarball",
  );
  report.tarball = {
    integrity: packed.integrity,
    filename: packed.filename,
    files: packed.files.length,
  };
  const dependencies: Record<string, string> = {};
  for (const name of ["storage", "retrieval", "operations"])
    Object.assign(
      dependencies,
      JSON.parse(
        await readFile(
          join(
            root,
            `examples/_shared/tools/${name}/dependencies/package.json`,
          ),
          "utf8",
        ),
      ).dependencies,
    );
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({
      name: "capabilities-consumer",
      private: true,
      type: "module",
    }),
  );
  const [retrievalPacked] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", app], false, join(root, "packages/retrieval")));
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(app, packed.filename), join(app, retrievalPacked.filename),
    `typescript@${manifest.devDependencies.typescript}`,
    `@types/node@${manifest.devDependencies["@types/node"]}`,
    ...Object.entries(dependencies).map(([n, v]) => n + "@" + v),
  ]);
  const filter = (path: string) =>
    !path
      .split(/[\\/]/)
      .some((p) => ["node_modules", ".venv", "__pycache__"].includes(p));
  for (const dir of ["examples/capabilities", "examples/_shared/tools"])
    await cp(join(root, dir), join(app, dir), { recursive: true, filter });
  for (const category of Object.keys(capabilities) as Capability[]) {
    const name = suiteName(category);
    for (const file of [
      `scripts/check-examples-${name}-tasks.ts`,
      `scripts/fixtures/${name}-child.ts`,
    ])
      await cp(join(root, file), join(app, file), { recursive: true });
  }
  await cp(
    join(root, "scripts/lib/capability-cases.ts"),
    join(app, "scripts/lib/capability-cases.ts"),
    { recursive: true },
  );
  await cp(join(root, "ditto.yaml"), join(app, "ditto.yaml"));
  const loopGuide = await readFile(
    join(root, "docs/worker-api/graph-loops.md"),
    "utf8",
  );
  const loopExample = loopGuide.match(/```ts\n([\s\S]*?)\n```/)?.[1];
  assert.ok(
    loopExample,
    "Loop guide must contain a runnable public API example",
  );
  await writeFile(
    join(app, "scripts/loop-contract.ts"),
    loopExample +
      `
if (false) {
  // @ts-expect-error Graph input remains checked through graphStep.
  graphStep(load, { question: 123 });
  // @ts-expect-error Loop input must match the plan input.
  runtime.loop(workflow, { question: 123 });
  const result = await runtime.loop(workflow, { question: "test" });
  // @ts-expect-error Typed Graph output is preserved through the Loop result.
  const wrong: number = result;
  void wrong;
}
`,
  );
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
        noUnusedLocals: true,
        noUnusedParameters: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        noEmit: true,
        types: ["node"],
        allowImportingTsExtensions: true,
      },
      include: ["examples/**/*.ts", "scripts/**/*.ts"],
    }),
  );
  await run(join(app, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  for (const path of ["src", "node_modules/@codesoul-co/ditto/src", ".env"])
    assert.equal(
      await access(join(app, path)).then(
        () => true,
        () => false,
      ),
      false,
      `Consumer must not contain ${path}`,
    );
  await writeFile(
    join(app, "boundary-hook.mjs"),
    `import {registerHooks} from "node:module";
import {fileURLToPath} from "node:url";
import {relative,isAbsolute,resolve} from "node:path";
const app=${JSON.stringify(app)},core=resolve(app,"node_modules/@codesoul-co/ditto"),entries=new Set([...${JSON.stringify(audit.publicEntries)},"@codesoul-co/ditto-retrieval","@codesoul-co/ditto-retrieval/adapters/memory","@codesoul-co/ditto-retrieval/adapters/context"]);
function inside(root,path){const r=relative(root,path);return r===""||(!isAbsolute(r)&&r!==".."&&!r.startsWith("../")&&!r.startsWith("..\\\\"));}
registerHooks({resolve(specifier,context,next){
if(specifier.startsWith("@codesoul-co/ditto")&&!entries.has(specifier))throw new Error("Non-public Core entry");
const result=next(specifier,context);
if(result.url.startsWith("file:")){const path=fileURLToPath(result.url),parent=context.parentURL?.startsWith("file:")?fileURLToPath(context.parentURL):"";
if(!inside(app,path))throw new Error("Module outside consumer");
if(inside(core,path)&&!inside(core,parent)&&!entries.has(specifier))throw new Error("Core must be entered through public exports");}
return result;}});`,
  );
  const probes = [
    "@codesoul-co/ditto/src/index.ts",
    "@codesoul-co/ditto/dist/runtime/index.js",
    pathToFileURL(join(root, "dist/index.js")).href,
    pathToFileURL(join(app, "node_modules/@codesoul-co/ditto/dist/runtime/index.js"))
      .href,
  ];
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `for(const specifier of ${JSON.stringify(probes)}){let blocked=false;try{await import(specifier);}catch{blocked=true;}if(!blocked)throw new Error("Boundary bypass");}`,
    ],
    true,
  );
  const imports = Object.entries(capabilities)
    .flatMap(([c, names]) =>
      names.map((n) => `await import("./examples/capabilities/${c}/${n}.ts");`),
    )
    .join("\n");
  assert.equal(
    await run(process.execPath, ["--input-type=module", "-e", imports], true),
    "",
    "Imports must not start tasks",
  );
  report.consumerChecks = {
    strictTypes: true,
    pathAliases: false,
    sourceTreePresent: false,
    credentialFileCopied: false,
    importGuard: true,
    negativeProbes: probes.length,
    silentImports: audit.examples,
  };
  const loopOutput = await run(
    process.execPath,
    ["scripts/loop-contract.ts"],
    true,
  );
  assert.ok(
    loopOutput.includes("load-question completed") &&
      loopOutput.includes("select-context completed"),
  );
  Object.assign(report.consumerChecks as Record<string, unknown>, {
    loopGuide: true,
    loopTypeContracts: true,
  });
  await save();
  console.log(
    `Installed packages: ${audit.categories.length} categories, ${audit.examples} silent entries, strict public types passed.`,
  );
  if (!values["types-only"]) {
    if (selected.includes("tools"))
      await run(process.execPath, ["node_modules/electron/install.js"]);
    // Two independent suites at most; each retains its existing task assertions and fault cases.
    for (let i = 0; i < selected.length; i += 2)
      await Promise.all(
        selected.slice(i, i + 2).map(async (category) => {
          const name = suiteName(category),
            path = join(output, `${category}.json`),
            started = Date.now();
          console.log(`${category}: complete task acceptance started`);
          try {
            const stdout = await run(
              process.execPath,
              [
                `scripts/check-examples-${name}-tasks.ts`,
                "--output-dir",
                join(output, category),
                "--report",
                path,
                ...(category === "memory" && values["memory-backend"]
                  ? ["--backend", values["memory-backend"]]
                  : []),
              ],
              true,
            );
            await writeFile(join(output, `${category}.log`), stdout);
            const task = JSON.parse(await readFile(path, "utf8"));
            assert.ok(
              task.results.length >= capabilities[category].length &&
                task.results.every(
                  (r: { status?: string; passed?: boolean }) =>
                    r.passed === true || r.status === "passed",
                ),
            );
            results.push({
              category,
              status: "passed",
              scenarios: task.results.length,
              modelCalls: task.results.reduce(
                (n: number, r: { modelCalls?: number }) =>
                  n + (r.modelCalls ?? 0),
                0,
              ),
              report: path,
              durationMs: Date.now() - started,
            });
          } catch (e) {
            results.push({
              category,
              status: "failed",
              report: path,
              error: e instanceof Error ? e.message : "Acceptance failed",
              durationMs: Date.now() - started,
            });
          }
          await save();
          console.log(
            `${category}: ${results.find((r) => r.category === category)!.status}`,
          );
        }),
      );
    assert.equal(
      results.filter((r) => r.status !== "passed").length,
      0,
      "Capability acceptance failed; inspect per-category reports",
    );
  }
  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify(
      {
        status: report.status,
        examples: audit.examples,
        categories: selected,
        results,
        report: resolve(values.report!),
      },
      null,
      2,
    ),
  );
} catch (e) {
  report.status = "failed";
  report.error = e instanceof Error ? e.message : "Package validation failed";
  await save();
  throw e;
} finally {
  await rm(app, { recursive: true, force: true });
}
