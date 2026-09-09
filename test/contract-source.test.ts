import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("type parity baseline is the complete TypeScript from the reviewed contract", () => {
  const doc = readFileSync(new URL("../../docs/13-node-api-contract.md", import.meta.url), "utf8");
  const reference = readFileSync(new URL("../../test/reference-contract.ts", import.meta.url), "utf8");
  const blocks = [...doc.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd()).join("\n\n");
  assert.equal(reference.slice(reference.indexOf("\n") + 1).trim(), blocks.trim());
});
