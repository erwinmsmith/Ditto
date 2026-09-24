import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createContextWorker, createDitto, createInteractionWorker, createReadOnlyCommandTools, runToolCallFlow,
  type Context, type SandboxCommand, type SandboxExecutor,
} from "../src/index.js";
import { commandExecutor } from "../docs/worker-api/examples/interaction-tools.js";

const toolNames = [
  "grep", "ls", "cat", "find", "head", "tail", "wc", "sort", "uniq", "cut", "stat", "file", "du", "pwd",
] as const;

test("read-only command tools map structured inputs to fixed commands and literal arguments", async () => {
  const commands: SandboxCommand[] = [];
  const executor: SandboxExecutor = { async run(command) {
    commands.push(command);
    return { stdout: `${command.command}\n`, stderr: "", exitCode: 0 };
  } };
  const runtime = createDitto({
    sandbox: { tools: [...toolNames], execute: true }, sandboxExecutor: executor,
    workers: [createInteractionWorker({ tools: createReadOnlyCommandTools() })],
  });
  try {
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "grep-1", name: "grep", arguments: {
      pattern: "Needle", paths: ["src", "README.md"], recursive: true, ignoreCase: true, fixedStrings: true,
    } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "ls-1", name: "ls", arguments: { path: "src", all: true } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "cat-1", name: "cat", arguments: { path: "README.md" } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "find-1", name: "find", arguments: {
      path: "src", name: "*.ts", type: "file", maxDepth: 2,
    } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "head-1", name: "head", arguments: { path: "README.md", lines: 5 } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "tail-1", name: "tail", arguments: { path: "README.md", lines: 7 } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "wc-1", name: "wc", arguments: { path: "README.md", metric: "words" } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "sort-1", name: "sort", arguments: {
      path: "data.txt", reverse: true, numeric: true, unique: true,
    } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "uniq-1", name: "uniq", arguments: {
      path: "data.txt", count: true, ignoreCase: true,
    } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "cut-1", name: "cut", arguments: {
      path: "data.tsv", delimiter: "\t", fields: "1,3-5",
    } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "stat-1", name: "stat", arguments: { path: "README.md" } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "file-1", name: "file", arguments: { path: "README.md" } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "du-1", name: "du", arguments: { path: "src", maxDepth: 1 } } });
    await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "pwd-1", name: "pwd", arguments: {} } });
    assert.deepEqual(commands, [
      { command: "grep", args: ["-n", "-R", "-i", "-F", "--", "Needle", "src", "README.md"] },
      { command: "ls", args: ["-1", "-a", "--", "src"] },
      { command: "cat", args: ["--", "README.md"] },
      { command: "find", args: ["src", "-maxdepth", "2", "-type", "f", "-name", "*.ts", "-print"] },
      { command: "head", args: ["-n", "5", "--", "README.md"] },
      { command: "tail", args: ["-n", "7", "--", "README.md"] },
      { command: "wc", args: ["-w", "--", "README.md"] },
      { command: "sort", args: ["-r", "-n", "-u", "--", "data.txt"] },
      { command: "uniq", args: ["-c", "-i", "--", "data.txt"] },
      { command: "cut", args: ["-d", "\t", "-f", "1,3-5", "--", "data.tsv"] },
      { command: "stat", args: ["--", "README.md"] },
      { command: "file", args: ["--", "README.md"] },
      { command: "du", args: ["-k", "-d", "1", "--", "src"] },
      { command: "pwd", args: [] },
    ]);
  } finally { await runtime.close(); }
});

test("read-only command tools reject unsafe paths and undeclared command arguments before execution", async () => {
  let executed = 0;
  const runtime = createDitto({
    sandbox: { tools: [...toolNames], execute: true },
    sandboxExecutor: { async run() { executed++; return { stdout: "unused", stderr: "", exitCode: 0 }; } },
    workers: [createInteractionWorker({ tools: createReadOnlyCommandTools() })],
  });
  const invalid = [
    { name: "grep", arguments: { pattern: "x", paths: ["../secret"] } },
    { name: "ls", arguments: { path: "/etc" } },
    { name: "cat", arguments: { path: "C:\\Windows\\win.ini" } },
    { name: "find", arguments: { path: ".", args: ["-delete"] } },
    { name: "find", arguments: { path: ".", expression: "-exec rm -rf {} ;" } },
    { name: "head", arguments: { path: "README.md", lines: 1_001 } },
    { name: "cut", arguments: { path: "data.tsv", fields: "1;rm" } },
    { name: "du", arguments: { path: "../outside" } },
    { name: "pwd", arguments: { command: "whoami" } },
  ];
  try {
    for (const [index, item] of invalid.entries()) {
      await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", {
        call: { id: `invalid-${index}`, name: item.name, arguments: item.arguments },
      }));
    }
    assert.equal(executed, 0);
  } finally { await runtime.close(); }
});

test("read-only command tools bound output and expose nonzero exits without retry", async () => {
  let executed = 0;
  const runtime = createDitto({
    sandbox: { tools: [...toolNames], execute: true },
    sandboxExecutor: { async run({ command }) {
      executed++;
      return command === "grep"
        ? { stdout: "one\ntwo\nthree\nfour\n", stderr: "warning-warning", exitCode: 2 }
        : { stdout: "😀😀😀😀", stderr: "", exitCode: 0 };
    } },
    workers: [createInteractionWorker({ tools: createReadOnlyCommandTools({
      maxEntries: 2, maxOutputBytes: 12, maxErrorBytes: 7,
    }) })],
  });
  try {
    const failed = await runtime.invoke("INTERACTION.ACT.TOOL", { call: {
      id: "grep-failed", name: "grep", arguments: { pattern: "x", paths: ["."] },
    } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.code, "COMMAND_EXIT_NONZERO");
    assert.equal(executed, 1);
    assert.ok(Buffer.byteLength(String(failed.content)) <= 12);
    assert.ok(Buffer.byteLength(String((failed.structuredContent as { stderr: string }).stderr)) <= 7);
    assert.equal((failed.structuredContent as { truncated: boolean }).truncated, true);

    const unicode = await runtime.invoke("INTERACTION.ACT.TOOL", { call: {
      id: "cat-unicode", name: "cat", arguments: { path: "README.md" },
    } });
    assert.equal(unicode.status, "success");
    assert.ok(Buffer.byteLength(String(unicode.content)) <= 12);
    assert.doesNotMatch(String(unicode.content), /�/);
  } finally { await runtime.close(); }
});

test("read-only command tools require explicit registration plus tool and execute permissions", async () => {
  let executed = 0;
  const executor: SandboxExecutor = { async run() { executed++; return { stdout: "unused", stderr: "", exitCode: 0 }; } };
  const inputs = [
    { sandbox: { tools: [...toolNames] }, tools: createReadOnlyCommandTools() },
    { sandbox: { execute: true }, tools: createReadOnlyCommandTools() },
    { sandbox: { tools: [...toolNames], execute: true }, tools: undefined },
  ];
  for (const [index, input] of inputs.entries()) {
    const runtime = createDitto({ sandbox: input.sandbox, sandboxExecutor: executor,
      workers: [createInteractionWorker(input.tools ? { tools: input.tools } : undefined)] });
    try {
      await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: {
        id: `denied-${index}`, name: "cat", arguments: { path: "README.md" },
      } }));
    } finally { await runtime.close(); }
  }
  assert.equal(executed, 0);
  assert.throws(() => createReadOnlyCommandTools({ maxEntries: 10_001 }), /maxEntries/);
  assert.throws(() => createReadOnlyCommandTools({ maxOutputBytes: 1024 * 1024 + 1 }), /maxOutputBytes/);
});

test("real POSIX read-only commands flow through Observation into Context", { skip: process.platform === "win32" }, async () => {
  const fixtureDirectory = await mkdtemp(".test-dist/read-only-");
  const fixturePath = join(fixtureDirectory, "lines.txt");
  await writeFile(fixturePath, "bravo\nalpha\nalpha\n");
  const runtime = createDitto({
    sandbox: { tools: [...toolNames], execute: true }, sandboxExecutor: commandExecutor,
    workers: [createInteractionWorker({ tools: createReadOnlyCommandTools() }), createContextWorker()],
  });
  try {
    let context: Context = { items: [] };
    const calls = [
      { id: "grep-live", name: "grep", arguments: { pattern: "A lightweight Node-native", paths: ["README.md"], fixedStrings: true } },
      { id: "ls-live", name: "ls", arguments: { path: "src" } },
      { id: "cat-live", name: "cat", arguments: { path: fixturePath } },
      { id: "find-live", name: "find", arguments: { path: "src", name: "index.ts", type: "file", maxDepth: 4 } },
      { id: "head-live", name: "head", arguments: { path: "README.md", lines: 2 } },
      { id: "tail-live", name: "tail", arguments: { path: "README.md", lines: 2 } },
      { id: "wc-live", name: "wc", arguments: { path: "README.md", metric: "lines" } },
      { id: "sort-live", name: "sort", arguments: { path: fixturePath, unique: true } },
      { id: "uniq-live", name: "uniq", arguments: { path: fixturePath, count: true } },
      { id: "cut-live", name: "cut", arguments: { path: "README.md", delimiter: " ", fields: "1" } },
      { id: "stat-live", name: "stat", arguments: { path: "README.md" } },
      { id: "file-live", name: "file", arguments: { path: "README.md" } },
      { id: "du-live", name: "du", arguments: { path: "src", maxDepth: 0 } },
      { id: "pwd-live", name: "pwd", arguments: {} },
    ] as const;
    for (const call of calls) {
      const result = await runToolCallFlow(runtime, { context, call });
      assert.equal(result.output.status, "success", `${call.name}: ${JSON.stringify(result.output.structuredContent)}`);
      assert.equal(result.observation.source, call.name);
      if (call.name === "cat") assert.equal(result.output.content, "bravo\nalpha\nalpha\n");
      if (call.name === "sort") assert.equal(result.output.content, "alpha\nbravo\n");
      context = result.context;
    }
    assert.equal(context.items.length, toolNames.length);
  } finally {
    try { await runtime.close(); } finally { await rm(fixtureDirectory, { recursive: true, force: true }); }
  }
});
