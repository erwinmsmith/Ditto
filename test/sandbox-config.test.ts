import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRuntimeConfig, Sandbox, SkillRegistry } from "../src/index.js";

test("env config is explicit, validated and immutable; permissions deny by default", () => {
  const config = loadRuntimeConfig({ DITTO_PROVIDERS: "primary,local", DITTO_MODEL_PROVIDER: "local", DITTO_MODEL: "test",
    DITTO_PROVIDER_LOCAL_BASE_URL: "http://127.0.0.1:1234/v1", DITTO_ALLOW_TOOLS: "echo,add" });
  assert.equal(config.providers.local!.baseUrl, "http://127.0.0.1:1234/v1");
  assert.deepEqual(config.model, { provider: "local", model: "test" });
  assert.deepEqual(config.sandbox.tools, ["echo", "add"]);
  assert.equal(config.sandbox.write, false);
  assert.ok(Object.isFrozen(config.providers));
  for (const env of [{ DITTO_MAX_TURNS: "NaN" }, { DITTO_ENV: "unknown" }, { DITTO_MODEL: "orphan" },
    { DITTO_ALLOW_READ: "yes" }, { DITTO_PROVIDERS: "x,x" },
    { DITTO_PROVIDERS: "x", DITTO_PROVIDER_X_BASE_URL: "file:///tmp" }]) {
    assert.throws(() => loadRuntimeConfig(env));
  }
});

test("workspace permissions reject traversal, outside symlinks and dangling symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ditto-sandbox-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await writeFile(join(root, "secret"), "private");
    await writeFile(join(workspace, "SKILL.md"), "# Test skill");
    const denied = new Sandbox(workspace);
    await assert.rejects(denied.readText("SKILL.md"), /Permission denied/);
    await assert.rejects(denied.run({ command: "echo", args: [] }), /Permission denied/);
    const sandbox = new Sandbox(workspace, { read: true, write: true, skills: ["test"] });
    await sandbox.writeText("ok", "hello"); assert.equal(await sandbox.readText("ok"), "hello");
    await assert.rejects(sandbox.readText("../secret"), /Permission denied/);
    try {
      await symlink(join(root, "secret"), join(workspace, "escape"));
      await assert.rejects(sandbox.writeText("escape", "no"), /Permission denied/);
      await symlink(join(root, "new-file"), join(workspace, "dangling"));
      await assert.rejects(sandbox.writeText("dangling", "no"), /Permission denied/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // Windows without Developer Mode cannot create symlinks; CI covers these assertions.
    }
    const skills = new SkillRegistry(); await skills.load("test", "SKILL.md", sandbox);
    assert.equal(skills.get("test", sandbox).instructions, "# Test skill");
    assert.throws(() => skills.get("test", denied), /Permission denied/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
