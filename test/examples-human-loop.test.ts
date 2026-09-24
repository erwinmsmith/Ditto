import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDemo,
  ReviewApplication,
  request,
} from "../examples/_shared/tools/human-loop/adapters.ts";
test("human-loop rejects unbounded requests and preserves task identity", () => {
  const r = {
    id: "task",
    tenant: "demo",
    principal: "operator",
    goal: "Publish reviewed notice",
    sourceDigest: "a".repeat(64),
    maxModelCalls: 4,
    deadlineSeconds: 600,
  };
  assert.deepEqual(request(r), r);
  assert.throws(() => request({ ...r, maxModelCalls: 0 }));
  assert.throws(() => request({ ...r, deadlineSeconds: Infinity }));
  assert.throws(() => request({ ...r, id: "../other" }));
  assert.throws(() => request({ ...r, sourceDigest: "not a digest" }));
});
test("human-loop controller reads current permissions and is absent from model tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-hitl-test-"));
  const r = await createDemo(dir),
    app = await ReviewApplication.open(dir, r);
  try {
    assert.ok(
      app.tools.every((t) => !/(approve|decide|edit|claim)/.test(t.name)),
    );
    await app.actor("example-publisher", "publish");
    await assert.rejects(app.actor("example-publisher", "handoff"));
    await assert.rejects(app.actor("intruder", "publish"));
    const path = join(dir, "policy.json"),
      policy = JSON.parse(await readFile(path, "utf8"));
    policy.reviewers["example-publisher"] = [];
    await writeFile(path, JSON.stringify(policy));
    await assert.rejects(app.actor("example-publisher", "publish"));
    assert.equal(app.state().job.stage, "queued");
    assert.equal(
      app.store.db.prepare("SELECT count(*) AS n FROM effects").get()!.n,
      0,
    );
  } finally {
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("human-loop binds tool access to immutable source and request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-hitl-test-"));
  const r = await createDemo(dir),
    app = await ReviewApplication.open(dir, r);
  try {
    const source = join(dir, r.id + ".source.json"),
      saved = await readFile(source, "utf8"),
      v = JSON.parse(saved);
    v.change = "Different release";
    await writeFile(source, JSON.stringify(v));
    await assert.rejects(app.authorize(), /Source changed/);
    await writeFile(source, saved);
    await writeFile(
      join(dir, "request.json"),
      JSON.stringify({ ...r, principal: "other" }),
    );
    await assert.rejects(app.authorize(), /Task request changed/);
  } finally {
    app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
