/** Public package contract for all twelve Agent capability categories. */
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { auditSource, inside, sourceFiles } from "./control-flow-boundary.ts";
export const capabilities = {
  understanding: [
    "goal",
    "extract-parameters",
    "clarification",
    "conversation",
    "choices",
    "intent",
  ],
  planning: ["plan", "decompose", "dependencies", "budget", "tools"],
  retrieval: [
    "document-search",
    "knowledge-base",
    "web-search",
    "web-read",
    "multi-source",
    "rewrite",
    "expand",
    "source-location",
  ],
  analysis: [
    "aggregate",
    "deduplicate",
    "conflicts",
    "fact-check",
    "extract",
    "convert",
    "compare",
  ],
  context: ["load", "select", "assemble", "compress", "update"],
  memory: ["search", "write", "update", "task-state"],
  tools: [
    "selection",
    "parameters",
    "api",
    "database",
    "files",
    "code",
    "browser",
    "desktop",
    "message",
    "system-write",
  ],
  observation: ["read", "normalize", "errors", "state", "interpret"],
  content: [
    "generate",
    "rewrite",
    "summarize",
    "expand",
    "translate",
    "convert",
    "cite",
  ],
  multimodal: [
    "document-parsing",
    "document-comparison",
    "document-review",
    "image-understanding",
    "chart-understanding",
    "audio-transcription",
    "video-understanding",
    "meeting-notes",
  ],
  "data-and-code": [
    "query",
    "cleaning",
    "exploration",
    "calculation",
    "visualization",
    "interpretation",
    "code-search",
    "code-generation",
    "code-modification",
    "execution",
    "diagnosis",
    "code-review",
  ],
  validation: [
    "schema",
    "evaluate",
    "consistency",
    "permissions",
    "risk",
    "policy",
    "input-safety",
    "sensitive-data",
    "redaction",
  ],
} as const;
export type Capability = keyof typeof capabilities;
export const suiteName = (category: Capability) =>
  category === "tools"
    ? "operations"
    : category === "data-and-code"
      ? "data-code"
      : category;
export function auditCapabilitySource(
  source: string,
  file: string,
  publicEntries: readonly string[],
) {
  const imports = auditSource(source, file, publicEntries);
  assert.ok(
    !/\[\s*["'`](?:execute|instantiate)["'`]\s*\]\s*\(/.test(source),
    `${file}: computed Worker execution bypass`,
  );
  // The runtime resolver additionally blocks evaluated module URLs and private package paths.
  assert.ok(
    !/["'`][^"'`\n]*(?:@codesoul-co\/ditto\/(?:src|dist)|(?:\.\.\/)+src\/)[^"'`\n]*["'`]/.test(
      source,
    ),
    `${file}: private Core file reference`,
  );
  if (
    file.replaceAll("\\", "/").includes("/capabilities/") &&
    !file.endsWith("/fixtures.ts")
  ) {
    if (file.endsWith("/shared.ts"))
      assert.ok(!/\b(?:runtime|rt)\.run\s*\(/.test(source), `${file}: compose Graphs through Loop`);
    assert.ok(
      !/\bfetch\s*\(/.test(source),
      `${file}: model/service transport belongs in a registered adapter`,
    );
    assert.ok(
      !/\bcreate(?:Context|Memory|Infer|Interaction|Retrieval)Api\s*\(/.test(
        source,
      ),
      `${file}: capability orchestration must use Runtime graphs`,
    );
  }
  return imports;
}
export async function auditCapabilities(root: string) {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { name: string; exports: Record<string, unknown> };
  const publicEntries = Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : manifest.name + key.slice(1),
  );
  const folders = [
    join(root, "examples/capabilities"),
    join(root, "examples/_shared/tools"),
  ];
  const files = (await Promise.all(folders.map(sourceFiles))).flat(),
    used = new Set<string>();
  for (const file of files)
    for (const specifier of auditCapabilitySource(
      await readFile(file, "utf8"),
      file,
      publicEntries,
    )) {
      if (specifier.startsWith("@codesoul-co/ditto")) used.add(specifier);
      else if (specifier.startsWith(".")) {
        const target = await realpath(resolve(dirname(file), specifier));
        assert.ok(
          folders.some((folder) => inside(folder, target)),
          `${file}: dependency escapes application tree: ${specifier}`,
        );
      }
    }
  const matrix = [];
  for (const [category, entries] of Object.entries(capabilities)) {
    const directory = join(root, "examples/capabilities", category),
      shared = await readFile(join(directory, "shared.ts"), "utf8");
    assert.match(
      shared,
      /\b(?:runtime|rt)\.loop\(/,
      `${category}: missing Loop-owned Graph composition`,
    );
    assert.ok(
      !/\b(?:runtime|rt)\.run\(/.test(shared),
      `${category}: direct Graph scheduling outside Loop`,
    );
    assert.match(
      shared,
      /yield\*\s+graphStep\(/,
      `${category}: missing Graph plan steps`,
    );
    assert.match(
      shared,
      /export const run\w+Loop\s*=\s*loop\(/,
      `${category}: missing exported capability Loop`,
    );
    const nodes = [
      ...new Set(
        [
          ...shared.matchAll(
            /["']((?:CONTEXT|MEMORY|INFER|INTERACTION|RETRIEVAL)\.[A-Z.]+)["']/g,
          ),
        ].map((m) => m[1]!),
      ),
    ].sort();
    for (const name of [
      "CONTEXT.LOAD",
      "MEMORY.GET",
      "MEMORY.WRITE",
      "INFER.REASONING.SAMPLE",
      "INTERACTION.ACT.TOOL",
    ])
      assert.ok(
        nodes.includes(name),
        `${category}: missing ${name} integration`,
      );
    const discovered = [];
    for (const file of await sourceFiles(directory))
      if (/isMain\(import\.meta\.url\)/.test(await readFile(file, "utf8")))
        discovered.push(file);
    assert.deepEqual(
      discovered.sort(),
      entries.map((entry) => join(directory, entry + ".ts")).sort(),
      `${category}: register every runnable entry in the release gate`,
    );
    for (const entry of entries) {
      const file = join(directory, entry + ".ts");
      assert.ok(files.includes(file), `Missing ${category}/${entry}`);
      const source = await readFile(file, "utf8");
      assert.match(source, /from ["']\.\/shared\.ts["']/);
      assert.match(source, /isMain\(import\.meta\.url\)/);
    }
    matrix.push({ category, entries: [...entries], nodes });
  }
  return {
    categories: Object.keys(capabilities),
    examples: Object.values(capabilities).reduce((n, v) => n + v.length, 0),
    files: files.map((f) => relative(root, f)),
    publicEntries,
    usedEntries: [...used].sort(),
    matrix,
  };
}
