import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDemo } from "../examples/_shared/tools/react/service.ts";
import {
  createTask,
  ReactAdapters,
} from "../examples/_shared/tools/react/adapters.ts";
import {
  request,
  action,
  csv,
  catalog,
  type Request,
} from "../examples/_shared/tools/react/domain.ts";
const r: Request = {
  id: "task",
  tenant: "demo",
  principal: "operator",
  jobId: "JOB-204",
  goal: "Recover job",
  origin: "http://127.0.0.1:1234",
  mode: "recover",
  delivery: "api",
  maxSteps: 12,
  maxActions: 12,
  maxRepeatedActions: 3,
  deadlineSeconds: 600,
};
test("ReAct request and native action boundary reject arbitrary destinations, jobs and tools", () => {
  assert.throws(() => request({ ...r, origin: "http://169.254.169.254" }));
  assert.throws(() => request({ ...r, maxActions: 100 }));
  assert.throws(() =>
    action({ id: "a", name: "job_status", arguments: { jobId: "another" } }, r),
  );
  assert.throws(() =>
    action(
      { id: "a", name: "job_retry", arguments: { jobId: r.jobId } },
      { ...r, mode: "inspect" },
    ),
  );
  assert.throws(() =>
    action(
      {
        id: "a",
        name: "job_status",
        arguments: { jobId: r.jobId, url: "http://evil" },
      },
      r,
    ),
  );
  assert.ok(!catalog(r).some((t) => t.name === "react_publish"));
  assert.throws(
    () => csv("jobId,quantity,unitCents,totalCents\nJOB-204,7,350,9999\n", r),
    /totals/,
  );
});
test("reference job service reconciles repeated POSTs to a single transaction and real CSV", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-react-unit-"));
  const demo = await createDemo(dir);
  try {
    const adapter = new ReactAdapters(dir, demo.request);
    const first = await adapter.http("retry", undefined, true);
    const second = await adapter.http("retry", undefined, true);
    assert.deepEqual(first, second);
    assert.equal(
      demo.service.db.prepare("SELECT retries FROM jobs").get()!.retries,
      1,
    );
    const result = await adapter.http("result");
    assert.equal(csv(result!.csv, demo.request).totalCents, 2450);
  } finally {
    await demo.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("ReAct verification rejects early completion, false totals, fabricated evidence and changed snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-react-unit-"));
  const demo = await createDemo(dir, "completed");
  try {
    const r = await createTask(dir, demo.request),
      adapter = new ReactAdapters(dir, r),
      data = (await adapter.http("result"))!,
      e = await adapter.record("job_result", { jobId: r.jobId }, data);
    const candidate = {
      status: "completed" as const,
      summary: "Complete",
      totalCents: 2450,
      evidenceIds: [e.id],
    };
    assert.equal(
      (await adapter.verify({ ...candidate, evidenceIds: [] })).valid,
      false,
    );
    assert.equal(
      (await adapter.verify({ ...candidate, totalCents: 9999 })).valid,
      false,
    );
    assert.equal((await adapter.verify(candidate)).valid, true);
    await assert.rejects(
      adapter.verify({ ...candidate, evidenceIds: ["made-up"] }),
    );
    const path = join(dir, "evidence", e.id + ".json"),
      saved = JSON.parse(await readFile(path, "utf8"));
    saved.data.csv = "changed";
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(adapter.loadEvidence(e.id), /checksum/);
  } finally {
    await demo.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed jobs reject redundant effects even when a client sends a recovery POST", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-react-unit-"));
  const demo = await createDemo(dir, "completed");
  try {
    const adapter = new ReactAdapters(dir, demo.request);
    await adapter.http("retry", undefined, true);
    assert.equal(
      demo.service.db.prepare("SELECT retries FROM jobs").get()!.retries,
      0,
    );
    assert.equal(
      demo.service.db.prepare("SELECT count(*) AS n FROM operations").get()!.n,
      0,
    );
  } finally {
    await demo.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
