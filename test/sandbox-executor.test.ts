import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Sandbox, createLocalSandboxExecutor, loadRuntimeConfig, loadRuntimeConfigFile, type SandboxPolicy } from "../src/index.js";

const node = process.execPath;
test("local executor runs literal arguments in the workspace with explicit environment and nonzero exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-executor-"));
  const commands = [node], env = { DITTO_EXECUTOR_FIXTURE: "initial" };
  const executor = createLocalSandboxExecutor({ commands, env });
  commands.length = 0; env.DITTO_EXECUTOR_FIXTURE = "changed";
  const sandbox = new Sandbox(root, { execute: true }, executor);
  try {
    const result = await sandbox.run({ command: node, args: ["-e",
      'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],env:process.env.DITTO_EXECUTOR_FIXTURE,keys:Object.keys(process.env)}));process.stderr.write("warning");process.exitCode=7',
      "$(uname); spaces 中文"] });
    const data = JSON.parse(result.stdout);
    assert.equal(data.arg, "$(uname); spaces 中文"); assert.equal(data.env, "initial");
    // macOS adds its own text encoding variable at process startup.
    assert.deepEqual(data.keys.filter((key: string) => key !== "__CF_USER_TEXT_ENCODING").sort(), ["DITTO_EXECUTOR_FIXTURE", "PATH"]);
    assert.match(data.cwd, /ditto-executor-/); assert.equal(result.stderr, "warning"); assert.equal(result.exitCode, 7);
    await assert.rejects(sandbox.run({ command: "sh", args: [] }), /not enabled/);
    await assert.rejects(new Sandbox(root, {}, executor).run({ command: node, args: [] }), /Permission denied/);
    await assert.rejects(sandbox.run({ command: node, args: ["\0"] }), /Invalid sandbox command/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local executor enforces output and time limits, reports spawn errors and reaps canceled children", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-executor-limit-"));
  try {
    const limited = new Sandbox(root, { execute: true }, createLocalSandboxExecutor({ commands: [node], maxOutputBytes: 4 }));
    await assert.rejects(limited.run({ command: node, args: ["-e", 'process.stdout.write("123");process.stderr.write("456")'] }), /maxOutputBytes/);
    const timed = new Sandbox(root, { execute: true }, createLocalSandboxExecutor({ commands: [node], timeoutMs: 100 }));
    await assert.rejects(timed.run({ command: node, args: ["-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'] }), { name: "TimeoutError" });
    const missing = join(root, "missing");
    const absent = new Sandbox(root, { execute: true }, createLocalSandboxExecutor({ commands: [missing] }));
    await assert.rejects(absent.run({ command: missing, args: [] }), { code: "ENOENT" });
    const controller = new AbortController();
    const running = new Sandbox(root, { execute: true }, createLocalSandboxExecutor({ commands: [node] })).run({ command: node, args: ["-e",
      'require("node:fs").writeFileSync("pid",String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'] }, controller.signal);
    const rejected = assert.rejects(running, /stop child/);
    try {
      const deadline = AbortSignal.timeout(3000);
      let pid: number | undefined;
      while (pid === undefined) {
        deadline.throwIfAborted();
        try { pid = Number(await readFile(join(root, "pid"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await delay(5); }
      }
      controller.abort(new Error("stop child")); await rejected;
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { controller.abort(new Error("stop child")); await rejected; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox cancellation prevents execution and writes; command arguments are snapshotted before async path resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-sandbox-cancel-"));
  let calls = 0;
  const sandbox = new Sandbox(root, { execute: true, read: true, write: true }, { async run(command) {
    calls++; return { stdout: command.args.join(""), stderr: "", exitCode: 0 };
  } });
  try {
    await writeFile(join(root, "keep"), "original");
    const signal = AbortSignal.abort(new Error("already cancelled"));
    await assert.rejects(sandbox.run({ command: "test", args: [] }, signal), /already cancelled/);
    await assert.rejects(sandbox.writeText("keep", "changed", signal), /already cancelled/);
    await assert.rejects(sandbox.readText("keep", signal), /already cancelled/);
    assert.equal(calls, 0); assert.equal(await sandbox.readText("keep"), "original");
    const command = { command: "test", args: ["original"] };
    const pending = sandbox.run(command); command.args[0] = "changed";
    assert.equal((await pending).stdout, "original");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox and executor configuration rejects malformed policies and invalid limits at startup", () => {
  for (const policy of [{ execute: "false" }, { read: 1 }, { tools: "all" }, { network: [null] }]) {
    assert.throws(() => new Sandbox(process.cwd(), policy as unknown as SandboxPolicy), /Invalid sandbox/);
  }
  for (const options of [{ commands: ["./script"] }, { commands: [node], timeoutMs: 0 }, { commands: [node], maxOutputBytes: 0 }]) {
    assert.throws(() => createLocalSandboxExecutor(options));
  }
  const config = loadRuntimeConfigFile("ditto.yaml", {});
  assert.deepEqual(config.sandboxExecution, { timeoutMs: 5000, maxOutputBytes: 65536 });
  assert.ok(Object.isFrozen(config.sandboxExecution));
  assert.throws(() => loadRuntimeConfig({}, { runtime: { sandbox: { timeoutMs: 0 } } }));
});
