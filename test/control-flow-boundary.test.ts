import assert from "node:assert/strict";
import test from "node:test";
import { auditControlFlows, auditSource } from "../scripts/lib/control-flow-boundary.ts";
test("all seven control-flow categories use exported package entries and Runtime execution", async () => {
  const result = await auditControlFlows(process.cwd());
  assert.equal(result.categories.length, 7); assert.equal(result.examples, 38);
  assert.ok(result.usedEntries.includes("@codesoul-co/ditto/runtime"));
});
test("the public API boundary rejects internal paths, direct executors and computed imports", () => {
  const entries = ["@codesoul-co/ditto/runtime", "@codesoul-co/ditto/contracts"];
  for (const source of [
    'import { graph } from "../../../src/runtime/index.ts";',
    'export { graph } from "@codesoul-co/ditto/runtime/graph";',
    'import type { Context } from "@codesoul-co/ditto/dist/contracts/index.d.ts";',
    'await import("file:///repo/src/index.ts");',
    'await import(path);',
    'const sdk = require("redis");',
    'const executor = definition.instantiate();',
    'await worker.execute(node, input, context);',
    'await fetch("https://provider.example/infer");',
  ]) assert.throws(() => auditSource(source, "/app/examples/control-flow/shared.ts", entries));
  assert.deepEqual(auditSource('const sdk = require("redis");', "/app/examples/_shared/tools/storage/redis-context.ts", entries), ["redis"]);
  assert.deepEqual(auditSource('import { graph } from "@codesoul-co/ditto/runtime"; import type { Context } from "@codesoul-co/ditto/contracts"; await runtime.run(plan, input);', "/app/examples/control-flow/shared.ts", entries), entries);
});
