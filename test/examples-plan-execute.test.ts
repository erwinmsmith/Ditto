import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDemo,
  PlanAdapters,
} from "../examples/_shared/tools/plan-execute/adapters.ts";
import {
  plan,
  type Request,
  type Snapshot,
  type Plan,
} from "../examples/_shared/tools/plan-execute/domain.ts";
const r: Request = {
  id: "test",
  tenant: "demo",
  principal: "user",
  orderId: "ORDER",
  goal: "Fulfill",
  quantity: 2,
  maxShippingCents: 500,
  maxPlans: 3,
  maxActions: 12,
  deadlineSeconds: 600,
};
const s: Snapshot = {
  state: "new",
  stock: 10,
  standard: 300,
  economy: 400,
  carrier: null,
  cost: null,
};
const p: Plan = {
  goal: r.goal,
  status: "ready",
  reason: "Affordable",
  steps: [
    { id: "a", tool: "reserve_stock", dependsOn: [], expected: "reserved" },
    { id: "b", tool: "pack_order", dependsOn: ["a"], expected: "packed" },
    { id: "c", tool: "ship_standard", dependsOn: ["b"], expected: "shipped" },
    { id: "d", tool: "read_receipt", dependsOn: ["c"], expected: "receipt" },
  ],
};
test("whole plans reject cycles, missing steps, duplicate IDs, extra arguments and budget violations", () => {
  assert.deepEqual(plan(p, r, s), p);
  for (const mutate of [
    (x: Plan) => x.steps.pop(),
    (x: Plan) => x.steps[0]!.dependsOn.push("d"),
    (x: Plan) => (x.steps[1]!.id = "a"),
    (x: Plan) =>
      Object.assign(x.steps[0]!, { arguments: { orderId: "OTHER" } }),
  ]) {
    const q = structuredClone(p);
    mutate(q);
    assert.throws(() => plan(q, r, s));
  }
  assert.throws(() => plan(p, r, { ...s, standard: 900 }));
  assert.throws(() => plan(p, r, { ...s, state: "packed" }));
  assert.throws(() => plan({ ...p, status: "needs-human", steps: [] }, r, s));
  assert.equal(
    plan({ ...p, status: "needs-human", steps: [] }, r, { ...s, stock: 0 })
      .status,
    "needs-human",
  );
});
test("business transactions guard live prices and reconcile completed semantic operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-unit-"));
  let a: PlanAdapters | undefined;
  try {
    const request = await createDemo(dir, "price-change", r);
    a = new PlanAdapters(dir, request);
    a.operate("reserve_stock");
    a.operate("reserve_stock");
    assert.equal(a.snapshot().stock, 8);
    a.operate("pack_order");
    assert.throws(() => a!.operate("ship_standard"), /ENVIRONMENT_CHANGED/);
    assert.equal(
      a.db.prepare("SELECT count(*) AS n FROM operations").get()!.n,
      2,
    );
    const booking = a.operate("ship_economy");
    assert.equal(booking.data.cost, 400);
    assert.deepEqual(a.operate("ship_standard").data, booking.data);
    assert.equal(
      a.db
        .prepare("SELECT count(*) AS n FROM operations WHERE id='shipment'")
        .get()!.n,
      1,
    );
  } finally {
    a?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
