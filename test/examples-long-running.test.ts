import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createDemo,
  LongTaskAdapters,
} from "../examples/_shared/tools/long-running/adapters.ts";
import {
  batch,
  fact,
  disposition,
  reviews,
  checkpoint,
  idOf,
  type Batch,
  type Checkpoint,
} from "../examples/_shared/tools/long-running/domain.ts";
const proposal = (b: Batch) => ({
  batchId: b.id,
  reviews: b.items.map((i) => ({
    invoiceId: i.id,
    disposition: disposition(i),
    varianceCents: i.invoiceCents - i.purchaseOrderCents,
    summary: "Review based on invoice and receipt evidence",
    nextAction:
      "Follow the documented review process; this is not payment authorization",
    quote: fact(i),
  })),
});
test("long task reviews bind batch, coverage, amounts and evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-long-domain-"));
  try {
    const r = await createDemo(dir),
      a = new LongTaskAdapters(dir, r),
      rows = await a.load(),
      b = batch(r, rows, 2),
      p = proposal(b);
    assert.equal(reviews(p, b)[0]!.disposition, "amount-mismatch");
    assert.throws(() => reviews({ ...p, batchId: "0".repeat(64) }, b));
    assert.throws(() =>
      reviews({ ...p, reviews: [p.reviews[0], p.reviews[0]] }, b),
    );
    const forged = structuredClone(p);
    forged.reviews[0]!.varianceCents = 0;
    assert.throws(() => reviews(forged, b));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("commits are idempotent and checkpoint reconciliation recovers a committed batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-long-commit-"));
  try {
    const r = await createDemo(dir),
      a = new LongTaskAdapters(dir, r),
      rows = await a.load(),
      b = batch(r, rows, 0),
      p = proposal(b),
      first = await a.commit(0, p);
    assert.deepEqual(await a.commit(0, p), first);
    const c: Checkpoint = {
      protocol: 1,
      requestDigest: idOf(r),
      cursor: 0,
      receipts: [],
      status: "running",
      usage: { modelCalls: 1, startedAt: new Date().toISOString() },
      recoveredCommits: 0,
      errors: [],
    };
    const recovered = await a.reconcile(c);
    assert.equal(recovered.cursor, 2);
    assert.equal(recovered.recovered, 1);
    const changed = structuredClone(p);
    changed.reviews[0]!.summary = "Different result";
    await assert.rejects(a.commit(0, changed), /Idempotency conflict/);
    await assert.rejects(
      a.commit(4, proposal(batch(r, rows, 4))),
      /Out-of-order/,
    );
    const db = new DatabaseSync(join(dir, "reviews.sqlite"));
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM audit").get()!.n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM reviews").get()!.n, 2);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("receipt failure rolls back review rows and audit atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-long-transaction-"));
  try {
    const r = await createDemo(dir),
      a = new LongTaskAdapters(dir, r),
      rows = await a.load(),
      db = new DatabaseSync(join(dir, "reviews.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END",
      );
      await assert.rejects(
        a.commit(0, proposal(batch(r, rows, 0))),
        /receipt unavailable/,
      );
      assert.equal(db.prepare("SELECT count(*) n FROM reviews").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM receipts").get()!.n, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM audit").get()!.n, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("checkpoints reject protocol drift and invented progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ditto-long-checkpoint-"));
  try {
    const r = await createDemo(dir),
      a = new LongTaskAdapters(dir, r),
      rows = await a.load(),
      c: Checkpoint = {
        protocol: 1,
        requestDigest: idOf(r),
        cursor: 0,
        receipts: [],
        status: "paused",
        usage: { modelCalls: 0, startedAt: new Date().toISOString() },
        recoveredCommits: 0,
        errors: [],
      };
    assert.equal(checkpoint(c, r, rows).cursor, 0);
    assert.throws(() => checkpoint({ ...c, cursor: 2 }, r, rows));
    assert.throws(() => checkpoint({ ...c, status: "completed" }, r, rows));
    assert.throws(() => checkpoint({ ...c, protocol: 2 }, r, rows));
    const committed = await a.commit(0, proposal(batch(r, rows, 0)));
    assert.throws(
      () => checkpoint({ ...c, cursor: 2, receipts: [committed] }, r, rows),
      /budget/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
