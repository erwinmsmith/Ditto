export const original = `export function discount(cents, basisPoints) {
  return Math.round(cents * (100 - basisPoints) / 100);
}
`;
export const patched = `export function discount(cents, basisPoints) {
  return Math.round(cents * (10000 - basisPoints) / 10000);
}
`;
export const tests = `import assert from "node:assert/strict";
import test from "node:test";
import { discount } from ${JSON.stringify("./discount.mjs")};
test("1500 basis points", () => assert.equal(discount(10000, 1500), 8500));
test("zero discount", () => assert.equal(discount(10000, 0), 10000));
test("round cents", () => assert.equal(discount(999, 1500), 849));
`;
