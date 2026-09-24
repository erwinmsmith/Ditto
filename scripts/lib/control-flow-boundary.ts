/** Release gate for application examples: explicit public imports and Runtime-owned execution. */
import assert from "node:assert/strict";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
export const controlFlows = {
  sequence: ["pipeline", "dependencies", "stages", "batch"],
  routing: ["state-routing", "conditional", "branch-merge", "file-type", "risk", "confidence"],
  parallel: ["concurrency-limit", "planning", "fan-out-fan-in", "partial-results"],
  iteration: ["bounded-loop", "adaptive-loop", "improvement", "retrieval", "goal-check", "stop-conditions"],
  recovery: ["retry", "fallback", "timeout", "checkpoint-resume", "pause-resume", "session-resume", "compensation", "side-effect-check"],
  human: ["approval", "intermediate", "edit-and-continue", "review-publish", "escalation"],
  lifecycle: ["status-tracking", "state-check", "safe-stop", "scheduled", "event-triggered"],
} as const;
export type Category = keyof typeof controlFlows;
const optionalEntries = new Set([
  "@codesoul-co/ditto-retrieval",
  "@codesoul-co/ditto-retrieval/adapters/memory",
  "@codesoul-co/ditto-retrieval/adapters/context",
]);
export function inside(root: string, path: string): boolean { const rest = relative(root, path); return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); }
export async function sourceFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".venv", "__pycache__", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Example sources must not be symlinks: ${path}`);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path)); else if (entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths.sort();
}
/** Literal-import audit catches accidental coupling; the package gate also enforces resolved modules at runtime. */
export function auditSource(source: string, file: string, publicEntries: readonly string[]): string[] {
  const imports = [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)(["'])([^"'\r\n]+)\1/g)].map(match => match[2]!);
  assert.ok(!/\b(?:import|require)\s*\(\s*[^\s"']/.test(source), `${file}: computed module imports require an explicit boundary review`);
  for (const specifier of imports) {
    if (specifier.startsWith("node:")) continue;
    // Explicit third-party SDK dependency, confined to the application storage adapter.
    if (["playwright", "electron", "nodemailer", "smtp-server"].includes(specifier) && file.replaceAll("\\", "/").endsWith("/examples/_shared/tools/operations/sdk.ts")) continue;
    if (specifier === "redis" && file.replaceAll("\\", "/").endsWith("/examples/_shared/tools/storage/redis-context.ts")) continue;
    if (specifier === "pg" && file.replaceAll("\\", "/").endsWith("/examples/_shared/tools/storage/postgres-memory.ts")) continue;
    if (specifier === "linkedom" && file.replaceAll("\\", "/").endsWith("/examples/_shared/tools/retrieval/web.ts")) continue;
    if (specifier.startsWith("@codesoul-co/ditto")) { assert.ok(publicEntries.includes(specifier) || optionalEntries.has(specifier), `${file}: non-public package import ${specifier}`); continue; }
    assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${file}: only public Core, Node and application-relative imports are allowed: ${specifier}`);
    assert.ok(!specifier.split("/").some(part => ["src", "dist", "node_modules"].includes(part)), `${file}: internal implementation path ${specifier}`);
  }
  assert.ok(!/\.\s*(?:instantiate|execute)\s*\(/.test(source), `${file}: examples must execute Workers through Runtime`);
  if (file.replaceAll("\\", "/").includes("/control-flow/")) assert.ok(!/\bfetch\s*\(/.test(source), `${file}: external transport belongs in a registered application adapter`);
  return imports;
}
export async function auditControlFlows(root: string) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; exports: Record<string, unknown> };
  const publicEntries = Object.keys(manifest.exports).map(key => key === "." ? manifest.name : manifest.name + key.slice(1));
  const folders = [join(root, "examples/control-flow"), join(root, "examples/_shared/tools")];
  const files = (await Promise.all(folders.map(sourceFiles))).flat(), used = new Set<string>();
  for (const file of files) {
    for (const specifier of auditSource(await readFile(file, "utf8"), file, publicEntries)) {
      if (specifier.startsWith("@codesoul-co/ditto")) used.add(specifier);
      else if (specifier.startsWith(".")) {
        const target = await realpath(resolve(dirname(file), specifier));
        assert.ok(folders.some(folder => inside(folder, target)), `${file}: import escapes application example tree: ${specifier}`);
      }
    }
  }
  for (const [category, entries] of Object.entries(controlFlows)) for (const entry of entries) assert.ok(files.includes(join(root, "examples/control-flow", category, `${entry}.ts`)), `Missing example ${category}/${entry}`);
  return { files: files.map(file => relative(root, file)), publicEntries, usedEntries: [...used].sort(), examples: Object.values(controlFlows).reduce((n, entries) => n + entries.length, 0), categories: Object.keys(controlFlows) };
}
