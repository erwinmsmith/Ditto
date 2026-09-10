import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createDitto, defineNode, extendWorker } from "../src/index.js";
import type { MemoryItem, MemoryRetrieveInput } from "../src/worker/memory/index.js";
import type { ContextLoadInput } from "../src/worker/context/index.js";
import { createGenerateNode } from "../src/worker/reasoning/index.js";
import { createInteractionNodes } from "../src/worker/interaction/index.js";

test("capability modules own their Node contracts and implementation entry points", () => {
  const input: MemoryRetrieveInput = { query: { role: "user", content: "hello" } };
  const context: ContextLoadInput = { sources: [input.query] };
  assert.equal(context.sources.length, 1);
  assert.equal(typeof createGenerateNode(), "function");
  assert.deepEqual(Object.keys(createInteractionNodes()).sort(), [
    "INTERACTION.RUN", "INTERACTION.SKILL", "INTERACTION.TOOL", "REASONING.GENERATE",
  ]);
  for (const path of ["src/agent", "src/node.ts", "src/worker.ts", "src/providers", "src/sandbox"]) {
    assert.equal(existsSync(new URL(`../../${path}`, import.meta.url)), false, path);
  }
  for (const domain of ["memory", "context", "reasoning", "interaction"]) {
    assert.equal(existsSync(new URL(`../../src/worker/${domain}/contracts.ts`, import.meta.url)), true);
    assert.equal(existsSync(new URL(`../../src/worker/${domain}/node`, import.meta.url)), false);
  }
});

test("scoped Worker operations preserve resource isolation, capability routing and typed definitions", async () => {
  let created = 0;
  const memory = extendWorker("MEMORY", {
    resources: () => ({ id: ++created }),
    nodes: {
      RETRIEVE: async ({ query }, ctx) => [{ id: String(ctx.resources.id), message: query }],
    },
  });
  const query = { role: "user" as const, content: "test" };
  const runtime = createDitto({ workers: [memory, memory, extendWorker("INTERACTION", {
    nodes: { OUTPUT: defineNode("INTERACTION.OUTPUT", async ({ message }) => message) },
  })] });
  try {
    const first: readonly MemoryItem[] = await runtime.invoke("MEMORY.RETRIEVE", { query });
    const second = await runtime.invoke("MEMORY.RETRIEVE", { query });
    assert.equal(first[0]!.id, "1"); assert.equal(second[0]!.id, "2");
    assert.equal(await runtime.invoke("INTERACTION.OUTPUT", { message: query }), query);
    assert.deepEqual(memory.capabilities, ["MEMORY.RETRIEVE"]);
    await assert.rejects(runtime.invoke("MEMORY.WRITE", { memories: [] }), /No available Worker/);
    assert.throws(() => extendWorker("MEMORY", { nodes: {} }), /at least one Node/);
  } finally { await runtime.close(); }
});
