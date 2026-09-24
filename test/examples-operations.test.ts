import test from "node:test";
import assert from "node:assert/strict";
import { request, validatePlan, validateReceipt, allowed, note, type Request } from "../examples/_shared/tools/operations/domain.js";
const r: Request = { id: "task-a", tenant: "team-a", mode: "selection", authorized: true, orderId: "ORD-12", ticketId: "TKT-12", quantity: 3, unitCents: 450, weight: 5, country: "SG", currency: "USD", recipient: "operations@example.test", origin: "http://127.0.0.1:8080", smtpPort: 2525 };
test("tool selection uses a controller allowlist, not a model supplied capability", () => {
  assert.deepEqual(allowed(r), ["order_lookup", "inventory_lookup"]);
  assert.throws(() => validatePlan({ name: "crm_update", arguments: {} }, r), /allowlist/);
  assert.throws(() => validatePlan({ name: "order_lookup", arguments: { orderId: r.orderId, admin: true } }, r), /schema/);
});
test("argument completion cannot change the admitted order or shipping context", () => {
  assert.throws(() => validatePlan({ name: "order_lookup", arguments: { orderId: "PRIVATE-OTHER" } }, r), /argument/);
  const target = { ...r, mode: "parameters" as const };
  assert.throws(() => validatePlan({ name: "shipping_quote", arguments: { country: "SG", weight: 999, service: "express" } }, target));
});
test("file paths cannot escape the admitted workspace", () => {
  assert.throws(() => validatePlan({ name: "file_edit", arguments: { input: "draft.txt", output: "../outside", append: note(r) } }, { ...r, mode: "files" }), /argument/);
});
test("message recipient and content are fixed by the authorized task", () => {
  const args = { to: r.recipient, subject: r.ticketId, body: note(r) }, target = { ...r, mode: "message" as const };
  assert.equal(validatePlan({ name: "send_mail", arguments: args }, target).name, "send_mail");
  assert.throws(() => validatePlan({ name: "send_mail", arguments: { ...args, to: "outside@example.org" } }, target));
  assert.throws(() => validatePlan({ name: "send_mail", arguments: args }, { ...target, authorized: false }), /authorization/);
});
test("generated code remains bounded before entering the isolated executor", () => {
  const target = { ...r, mode: "code" as const };
  assert.throws(() => validatePlan({ name: "run_code", arguments: { code: "x".repeat(4001) } }, target));
  assert.throws(() => validatePlan({ name: "run_code", arguments: { code: "" } }, target));
});
test("successful tool status alone cannot validate a wrong business result", () => {
  const plan = validatePlan({ name: "order_lookup", arguments: { orderId: r.orderId } }, r);
  assert.throws(() => validateReceipt({ operationId: r.id, tool: plan.name, value: { orderId: r.orderId, totalCents: 1 }, evidence: {} }, r, plan));
  assert.throws(() => validateReceipt({ operationId: "other", tool: plan.name, value: { orderId: r.orderId, totalCents: 1350 }, evidence: {} }, r, plan));
});
test("CRM receipts must confirm both the requested content and state transition", () => {
  const target = { ...r, mode: "system-write" as const }, plan = validatePlan({ name: "crm_update", arguments: { ticketId: r.ticketId, status: "resolved", note: note(r) } }, target);
  assert.throws(() => validateReceipt({ operationId: r.id, tool: plan.name, value: { note: note(r), status: "open" }, evidence: {} }, target, plan));
});
test("checkpoint fingerprints use a canonical request layout", () => {
  assert.equal(JSON.stringify(request(r)), JSON.stringify(request(Object.fromEntries(Object.entries(r).reverse()))));
  assert.throws(() => request({ ...r, origin: "file:///tmp" })); assert.throws(() => request({ ...r, tenant: "a:b" }));
});
