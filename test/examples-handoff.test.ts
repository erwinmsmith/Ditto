import assert from "node:assert/strict";
import test from "node:test";
import {
  evidence,
  decision,
  acceptance,
  packetId,
  type Sources,
  type Packet,
} from "../examples/_shared/tools/handoff/domain.ts";
const source: Sources = {
  orderId: "ORDER-204",
  issue: "Power failure",
  diagnostic: "hardware-fault",
  warranty: true,
  customerEmail: "private@example.invalid",
};
const output = (
  role: "customer-service" | "technical-support" | "after-sales",
) => {
  const e = evidence(source, role);
  return {
    agent: role,
    ...e.allowed,
    summary: "Read the available record",
    nextTask:
      e.allowed.action === "handoff" ? "Handle the next responsibility" : null,
    citations: e.facts,
  };
};
test("handoff enforces role route and source projection", () => {
  const e = evidence(source, "customer-service"),
    d = output("customer-service");
  assert.equal(decision(d, e).to, "technical-support");
  assert.throws(() => decision({ ...d, to: "after-sales" }, e));
  assert.throws(() =>
    decision({ ...d, action: "complete", to: null, resolution: "resolved" }, e),
  );
  assert.ok(!JSON.stringify(e).includes("private@example.invalid"));
  assert.ok(!JSON.stringify(e).includes("hardware-fault"));
});
test("handoff preserves exact evidence and cannot fabricate a replacement", () => {
  const e = evidence(source, "technical-support"),
    d = output("technical-support");
  assert.throws(() =>
    decision(
      { ...d, citations: [d.citations[0], d.citations[0], d.citations[0]] },
      e,
    ),
  );
  assert.throws(() =>
    decision(
      { ...d, citations: d.citations.map((c) => ({ ...c, quote: "forged" })) },
      e,
    ),
  );
  assert.equal(
    evidence({ ...source, diagnostic: "missing" }, "technical-support").allowed
      .action,
    "escalate",
  );
  assert.equal(
    evidence({ ...source, diagnostic: "resolved" }, "technical-support").allowed
      .resolution,
    "resolved",
  );
  assert.throws(() =>
    decision(
      output("after-sales"),
      evidence({ ...source, warranty: false }, "after-sales"),
    ),
  );
});
test("handoff acknowledgement binds the exact receiver, packet and parent chain", () => {
  const p: Packet = {
    requestDigest: "a".repeat(64),
    version: 0,
    from: "customer-service",
    to: "technical-support",
    decision: decision(
      output("customer-service"),
      evidence(source, "customer-service"),
    ),
    parentId: null,
  };
  const id = packetId(p),
    a = {
      agent: "technical-support",
      packetId: id,
      accepted: true,
      summary: "I accept diagnosis responsibility",
    };
  assert.equal(acceptance(a, id, "technical-support").accepted, true);
  assert.throws(() =>
    acceptance({ ...a, accepted: false }, id, "technical-support"),
  );
  assert.throws(() => acceptance(a, id, "after-sales"));
  assert.throws(() =>
    acceptance(
      a,
      packetId({ ...p, parentId: "b".repeat(64) }),
      "technical-support",
    ),
  );
  assert.notEqual(
    id,
    packetId({
      ...p,
      decision: { ...p.decision, nextTask: "Changed responsibility" },
    }),
  );
});
