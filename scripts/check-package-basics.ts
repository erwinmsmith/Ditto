/** Verify actual tarballs or published versions in a consumer outside the repository. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { randomUUID } from "node:crypto";
const { values } = parseArgs({ options: { live: { type: "boolean" }, registry: { type: "boolean" } } });
const root = process.cwd(), exec = promisify(execFile);
const app = await mkdtemp(join(tmpdir(), "ditto-basics-consumer-"));
const release = join(root, ".release");
const report: Record<string, unknown> = { mode: values.registry ? "registry" : "tarball", live: Boolean(values.live), status: "running" };
const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
async function run(command: string, args: string[], cwd = app, expectedFailure = false) {
  try { return (await exec(command, args, { cwd, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) { if (!expectedFailure && error && typeof error === "object" && "stderr" in error) console.error(error.stderr); throw error; }
}
const core = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const retrieval = JSON.parse(await readFile(join(root, "packages/retrieval/package.json"), "utf8"));
async function runFirstJavaScriptBlock(document: string, expected: string) {
  const markdown = await readFile(join(root, document), "utf8");
  const code = /```js\n([\s\S]*?)\n```/.exec(markdown)?.[1];
  assert.ok(code, `Missing runnable JavaScript in ${document}`);
  await writeFile(join(app, "readme-example.mjs"), code);
  assert.ok((await run(process.execPath, ["readme-example.mjs"])).includes(expected), document);
}
try {
  await mkdir(release, { recursive: true });
  const artifacts: { name: string; version: string; path: string; integrity: string }[] = [];
  for (const directory of [root, join(root, "packages/retrieval")]) {
    const [pack] = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", release], directory));
    assert.ok(pack.files.every((f: { path: string }) => f.path.startsWith("dist/") || /^(?:package\.json|README(?:\.zh-CN)?\.md|LICENSE)$/.test(f.path)), "Unexpected source, local instructions or credentials in package");
    if (pack.name === core.name) assert.ok(!pack.files.some((f: { path: string }) => f.path.includes("worker/retrieval")));
    artifacts.push({ name: pack.name, version: pack.version, path: join(release, pack.filename), integrity: pack.integrity });
  }
  report.artifacts = artifacts;
  if (values.registry) for (const artifact of artifacts) {
    const integrity = JSON.parse(await run("npm", ["view", `${artifact.name}@${artifact.version}`, "dist.integrity", "--json"]));
    assert.equal(integrity, artifact.integrity, "Published tarball differs from the verified local artifact");
  }
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const install = (name: string) => values.registry ? `${name}@${core.version}` : artifacts.find(a => a.name === name)!.path;
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", install(core.name), `@types/node@${core.devDependencies["@types/node"]}`, "redis@6.2.1"]);
  await cp(join(root, "examples/package-basics"), join(app, "examples/package-basics"), { recursive: true });
  for (const name of ["workers.ts", "redis-context.ts", "sqlite-memory.ts", "sql-memory.ts", "dependencies/package.json"]) {
    await cp(join(root, "examples/_shared/tools/storage", name), join(app, "examples/_shared/tools/storage", name), { recursive: true });
  }
  await cp(join(root, "examples/_shared/tools/package-basics.ts"), join(app, "examples/_shared/tools/package-basics.ts"));
  await run(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict';
for(const name of ${JSON.stringify(Object.keys(core.exports).map(k => core.name + (k === "." ? "" : k.slice(1))))}) await import(name);
await assert.rejects(import(${JSON.stringify(retrieval.name)}));
await assert.rejects(import(${JSON.stringify(core.name + "/src/index.ts")}));
await assert.rejects(import(${JSON.stringify(core.name + "/dist/index.js")}));`]);
  const context = JSON.parse(await run(process.execPath, ["examples/package-basics/context.ts", "Hello Ditto"]));
  assert.equal(context.context.items[0].content, "Hello Ditto");
  const tools = JSON.parse(await run(process.execPath, ["examples/package-basics/tools.ts", "A😀"]));
  assert.equal(tools.counted.structuredContent.characters, 2);
  for (const document of ["README.md", "README.zh-CN.md", "docs/package-guide.md", "docs/package-guide.zh-CN.md"]) {
    await runFirstJavaScriptBlock(document, "Hello Ditto");
  }
  const compilerOptions = { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, noEmit: true,
    types: ["node"], allowImportingTsExtensions: true };
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["examples/**/*.ts"], exclude: ["examples/package-basics/retrieval.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  report.coreOnly = { publicEntries: Object.keys(core.exports).length, context: true, tools: true, strictTypes: true, retrievalAbsent: true };
  console.log("Core-only consumer: all public entries, Context, tools and strict types passed.");
  if (values.live) {
    const session = `test-${randomUUID()}`, code = `orchid-${randomUUID().slice(0, 8)}`;
    const directory = join(app, "task");
    const prompt1 = `Remember my project code: ${code}. Repeat it exactly.`, prompt2 = "What is my project code? Reply with the code only.";
    const agent = async (turn: string, prompt: string, expectedFailure = false) => JSON.parse(await run(process.execPath, ["examples/package-basics/agent.ts", "--directory", directory, "--session", session, "--turn", turn, "--prompt", prompt], app, expectedFailure));
    const first = await agent("turn-1", prompt1);
    assert.ok(first.answer.includes(code)); assert.equal(first.replayed, false);
    // Expire real Redis state before the next process; SQLite must supply the history.
    await run(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {createClient} from 'redis'; import {contextScopeKey} from '${core.name}/worker/context';
const c=createClient({url:process.env.DITTO_WORKER_CONTEXT_REDIS_URL}); c.on('error',()=>{}); await c.connect();
try {const key='ditto:context:'+contextScopeKey({sessionId:${JSON.stringify("package-basics:" + session)},turnId:'turn-1'}); assert.ok(await c.exists(key)); await c.pExpire(key,1); await new Promise(r=>setTimeout(r,20)); assert.equal(await c.get(key),null);} finally {await c.quit();}`]);
    const second = await agent("turn-2", prompt2);
    assert.ok(second.answer.includes(code)); assert.equal(second.replayed, false);
    assert.equal((await readFile(second.file, "utf8")).trim(), second.answer.trim());
    const replay = await agent("turn-2", prompt2);
    assert.equal(replay.replayed, true); assert.equal(replay.answer, second.answer);
    await assert.rejects(agent("turn-2", "A different request", true));
    await run(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(${JSON.stringify(join(directory, session, "memory.sqlite"))}); try { const rows=db.prepare('SELECT content FROM memories').all(); assert.equal(rows.length,1); const memory=JSON.parse(rows[0].content); assert.equal(memory.turn,'turn-2'); assert.equal(memory.messages.length,4); assert.ok(memory.answer.includes(${JSON.stringify(code)})); } finally {db.close();}`]);
    report.agent = { realModel: true, context: "Redis", memory: "file SQLite", processRestarts: true, cacheExpiry: true, replay: true, changedRequestRejected: true, artifactVerified: true };
    console.log("Live consumer Agent: real model, Redis expiry, SQLite recovery, replay and answer file passed.");
  }
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", install(retrieval.name)]);
  await runFirstJavaScriptBlock("packages/retrieval/README.md", "guide.md#context");
  const hits = JSON.parse(await run(process.execPath, ["examples/package-basics/retrieval.ts", "Redis"]));
  assert.equal(hits.candidates[0].id, "context");
  const empty = JSON.parse(await run(process.execPath, ["examples/package-basics/retrieval.ts", "missingterm"]));
  assert.equal(empty.candidates.length, 0);
  await writeFile(join(app, "contract.ts"), `import type {InputOf, OutputOf, NodeResult} from '${core.name}';
import type {RetrievalSearchInput, RetrievalSearchOutput} from '${retrieval.name}';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Expect<T extends true>=T;
export type Contract=[Expect<Equal<InputOf<'RETRIEVAL.SEARCH'>,RetrievalSearchInput>>,Expect<Equal<OutputOf<'RETRIEVAL.SEARCH'>,NodeResult<RetrievalSearchOutput>>>];`);
  await writeFile(join(app, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["examples/**/*.ts", "contract.ts"] }));
  await run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"]);
  await run(process.execPath, ["--input-type=module", "-e", `for(const name of ${JSON.stringify(Object.keys(retrieval.exports).map(k => retrieval.name + (k === "." ? "" : k.slice(1))))}) await import(name); for(const file of ['context','tools','agent','retrieval']) await import('./examples/package-basics/'+file+'.ts');`]).then(stdout => assert.equal(stdout, ""));
  for (const name of [core.name, retrieval.name]) assert.equal(await access(join(app, "node_modules", name, "src")).then(() => true, () => false), false);
  report.retrieval = { publicEntries: Object.keys(retrieval.exports).length, matches: true, empty: true, contractAugmentation: true, silentImports: true };
  report.status = "passed";
  report.documentationExamples = { executed: 5, passed: true };
  console.log("Optional retrieval consumer: search, empty results, all exports and contract augmentation passed.");
} catch (error) { report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await writeFile(resolve(root, `.examples-package-basics-${values.registry ? "registry" : "tarball"}-live-results.json`), JSON.stringify(report, null, 2) + "\n");
  await rm(app, { recursive: true, force: true });
}
