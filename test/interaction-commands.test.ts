import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { type } from "node:os";
import test from "node:test";
import { createDitto, createInteractionWorker, loop } from "../src/index.js";
import { commandExecutor, linuxTool, sha256Tool, toolGraph, type CommandInput } from "../docs/worker-api/examples/interaction-tools.js";

test("real POSIX commands compose with a second tool, observations and output in a Loop", { skip: process.platform === "win32" }, async () => {
  const deliveries: string[] = [];
  const inputs: (CommandInput & { expected: string })[] = [
    { id: "os", command: "uname", args: ["-s"], expected: `${type()}\n` },
    { id: "literal", command: "printf", args: ["%s", "空格 ; $(uname) `pwd` | > stay literal"], expected: "空格 ; $(uname) `pwd` | > stay literal" },
    { id: "cwd", command: "pwd", args: [], expected: `${await realpath(process.cwd())}\n` },
  ];
  const runtime = createDitto({ sandbox: { tools: ["linux", "sha256"], execute: true }, sandboxExecutor: commandExecutor,
    workers: [createInteractionWorker({ tools: [linuxTool, sha256Tool], output: { async deliver(input) {
      deliveries.push(input.deliveryId); return { deliveryId: input.deliveryId, status: "accepted" };
    } } })],
  });
  try {
    const final = await runtime.loop(loop({ graph: toolGraph, maxIterations: inputs.length,
      bind: (index: number) => inputs[index]!,
      update(index, result) {
        const expected = inputs[index]!.expected;
        assert.equal(result.command.status, "success");
        assert.deepEqual(result.command.structuredContent, { stdout: expected, stderr: "", exitCode: 0 });
        assert.equal(result.hash.content, createHash("sha256").update(expected).digest("hex"));
        assert.equal(result.commandObservation.callId, inputs[index]!.id);
        assert.equal(result.hashObservation.callId, `${inputs[index]!.id}:hash`);
        assert.equal(result.deliver.status, "accepted");
        return index + 1;
      }, done: index => index === inputs.length,
    }), 0);
    assert.equal(final, inputs.length);
    assert.deepEqual(deliveries, inputs.map(input => `${input.id}:delivery`));
  } finally { await runtime.close(); }
});

test("a real nonzero command exit is observable and stops dependent tool work", { skip: process.platform === "win32" }, async () => {
  let hashes = 0;
  const runtime = createDitto({ sandbox: { tools: ["linux", "sha256"], execute: true }, sandboxExecutor: commandExecutor,
    workers: [createInteractionWorker({ tools: [linuxTool, { ...sha256Tool, async execute(args, ctx) { hashes++; return sha256Tool.execute(args, ctx); } }] })],
  });
  try {
    const failed = await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "failure", name: "linux", arguments: { command: "false", args: [] } } });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.structuredContent, { stdout: "", stderr: "", exitCode: 1 });
    const observed = await runtime.invoke("INTERACTION.OBSERVE", { result: failed });
    assert.equal(observed.error?.code, "COMMAND_EXIT_NONZERO");
    await assert.rejects(runtime.run(toolGraph, { id: "stop", command: "false", args: [] }), /Command did not produce/);
    assert.equal(hashes, 0);
  } finally { await runtime.close(); }
});

test("command permissions and argument validation reject before the executor runs", async () => {
  let executed = 0;
  const sandboxExecutor = { async run() { executed++; return { stdout: "unused", stderr: "", exitCode: 0 }; } };
  for (const sandbox of [{ tools: ["linux"] }, { execute: true }, { tools: ["linux"], execute: true }]) {
    const runtime = createDitto({ sandbox, sandboxExecutor, workers: [createInteractionWorker({ tools: [linuxTool] })] });
    try {
      const args = sandbox.tools && sandbox.execute ? [42] : [];
      await assert.rejects(runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "denied", name: "linux", arguments: { command: "uname", args } } }));
    } finally { await runtime.close(); }
  }
  assert.equal(executed, 0);
  await assert.rejects(commandExecutor.run({ command: "sh", args: ["-c", "exit 0"] }, { workspace: process.cwd() }), /not enabled/);
});
