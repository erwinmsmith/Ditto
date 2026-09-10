import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("type parity baseline preserves reviewed data contracts without the historical empty classes", () => {
  const reference = readFileSync(new URL("../../test/reference-contract.ts", import.meta.url), "utf8");
  for (const language of ["", ".zh-CN"]) {
    const doc = readFileSync(new URL(`../../docs/13-node-api-contract${language}.md`, import.meta.url), "utf8");
    const blocks = [...doc.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!.trimEnd()).join("\n\n");
    const dataContracts = blocks.slice(0, blocks.indexOf("export abstract class BaseNode"));
    assert.equal(reference.slice(reference.indexOf("\n") + 1).trim(), dataContracts.trim(), language || "English");
  }
});
