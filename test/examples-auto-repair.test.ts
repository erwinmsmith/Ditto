import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  content,
  patch,
  type Run,
} from "../examples/_shared/tools/auto-repair/domain.ts";
import {
  createDemo,
  RepairAdapters,
} from "../examples/_shared/tools/auto-repair/adapters.ts";
import { idOf } from "../examples/_shared/tools/auto-repair/domain.ts";
test("repair edit language blocks host APIs and SQL writes", () => {
  for (const bad of [
    "process.exit(0)",
    "globalThis.fetch('x')",
    "amountCents.constructor.constructor('x')()",
    "import('node:fs')",
    "1; while(true){}",
    "1/* comment */+2",
    "Math.random()",
  ])
    assert.throws(() => content("code", bad));
  assert.throws(() =>
    content(
      "sql",
      "SELECT region, SUM(cents) AS totalCents FROM orders GROUP BY region ORDER BY region; DROP TABLE orders",
    ),
  );
  assert.throws(() =>
    content(
      "config",
      JSON.stringify({
        delimiter: ",",
        amountColumn: "cents",
        statusFilter: "paid",
        command: "sh",
      }),
    ),
  );
  assert.equal(
    content("code", "Math.round(amountCents * (1 - discountBps / 10000))"),
    "Math.round(amountCents * (1 - discountBps / 10000))",
  );
});
test("repair binds each change to the exact failed revision and execution", () => {
  const failed: Run = {
    id: "b".repeat(64),
    revisionId: "a".repeat(64),
    status: "failed",
    errorCode: "EXECUTION_ERROR",
    exitCode: 1,
    stdout: "test failed",
    stderr: "",
    checks: [{ name: "test", passed: false }],
  };
  const p = {
    baseRevisionId: failed.revisionId,
    executionId: failed.id,
    diagnosis: "bps divisor",
    changeSummary: "use 10000",
    content: "amountCents / 10000",
  };
  assert.equal(
    patch(p, "code", failed.revisionId, failed, "amountCents / 100").content,
    p.content,
  );
  for (const v of [
    { ...p, executionId: "c".repeat(64) },
    { ...p, baseRevisionId: "c".repeat(64) },
    { ...p, path: "tests.mjs" },
    { ...p, content: "amountCents / 100" },
  ])
    assert.throws(() =>
      patch(v, "code", failed.revisionId, failed, "amountCents / 100"),
    );
  assert.throws(() =>
    patch(
      p,
      "code",
      failed.revisionId,
      { ...failed, status: "passed" },
      "amountCents / 100",
    ),
  );
});
test("actual code tests fail initially and pass only for a verified revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-repair-unit-"));
  try {
    const r = await createDemo(dir),
      a = new RepairAdapters(dir, r);
    const initial = "Math.round(amountCents * (1 - discountBps / 100))";
    const base = await a.storeRevision({
      requestDigest: idOf(r),
      parentId: null,
      content: initial,
      patch: null,
    });
    const failed = await a.performOperation(base);
    assert.equal(failed.status, "failed");
    assert.match(failed.stdout, /not ok/);
    assert.deepEqual(await a.performOperation(base), failed);
    const change = patch(
      {
        baseRevisionId: base,
        executionId: failed.id,
        diagnosis: "wrong basis point denominator",
        changeSummary: "divide by 10000",
        content: "Math.round(amountCents * (1 - discountBps / 10000))",
      },
      "code",
      base,
      failed,
      initial,
    );
    const fixed = await a.storeRevision({
      requestDigest: idOf(r),
      parentId: base,
      content: change.content,
      patch: change,
    });
    assert.equal((await a.performOperation(fixed)).status, "passed");
    const path = join(dir, "revisions", base, "discount.test.mjs");
    await writeFile(path, (await readFile(path, "utf8")) + "// changed");
    await assert.rejects(a.performOperation(base), /Test file changed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("SQL output must meet business acceptance, not merely execute successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-repair-sql-"));
  try {
    const r = await createDemo(dir, {}, "sql"),
      a = new RepairAdapters(dir, r);
    const id = await a.storeRevision({
      requestDigest: idOf(r),
      parentId: null,
      content:
        "SELECT region, SUM(cents) AS totalCents FROM orders GROUP BY region ORDER BY region",
      patch: null,
    });
    const out = await a.performOperation(id);
    assert.equal(out.exitCode, 0);
    assert.equal(out.status, "failed");
    assert.equal(out.errorCode, "RESULT_MISMATCH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
