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
    "INTERACTION.SKILL", "INTERACTION.TOOL", "INTERACTION.TOOL_BATCH",
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
    nodes: { OUTPUT: defineNode("INTERACTION", "INTERACTION.OUTPUT", async ({ message }) => message) },
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

test("Node definitions require an owner and cannot be mounted on a different Worker", () => {
  const retrieve = defineNode("MEMORY", "MEMORY.RETRIEVE", async () => []);
  assert.equal(retrieve.workerType, "MEMORY");
  assert.ok(Object.isFrozen(retrieve));
  assert.throws(() => defineNode("", "MEMORY.RETRIEVE", async () => []), /owning Worker/);
  assert.throws(() => extendWorker("MEMORY", { nodes: {
    RETRIEVE: defineNode("other-memory", "MEMORY.RETRIEVE", async () => []),
  } }), /belongs to Worker other-memory, not MEMORY/);
  assert.throws(() => extendWorker("MEMORY", { nodes: {
    // @ts-expect-error A structural Node definition must include its owning Worker type.
    RETRIEVE: { type: "MEMORY.RETRIEVE", execute: async () => [] },
  } }), /belongs to Worker undefined/);
  assert.throws(() => defineNode("MEMORY",
    // @ts-expect-error An unqualified name is not a declared Node contract.
    "RETRIEVE", async () => []), /fully qualified/);
});

test("a defined Node becomes routable only through its Worker; replicas have separate resources", async () => {
  const runtime = createDitto();
  let created = 0;
  const retrieve = defineNode<"MEMORY.RETRIEVE", { replica: number }>(
    "MEMORY", "MEMORY.RETRIEVE", async ({ query }, ctx) => {
      assert.equal(ctx.worker.workerType, "MEMORY");
      return [{ id: `${ctx.worker.workerId}:${ctx.resources.replica}`, message: query }];
    },
  );
  const query = { role: "user" as const, content: "remember" };
  await assert.rejects(runtime.invoke("MEMORY.RETRIEVE", { query }), /No available Worker/);
  const memory = extendWorker("MEMORY", {
    resources: () => ({ replica: ++created }), nodes: { RETRIEVE: retrieve },
  });
  runtime.register(memory, "a"); runtime.register(memory, "b");
  try {
    assert.equal((await runtime.invoke("MEMORY.RETRIEVE", { query }))[0]!.id, "a:1");
    assert.equal((await runtime.invoke("MEMORY.RETRIEVE", { query }))[0]!.id, "b:2");
  } finally { await runtime.close(); }
});

test("Worker creation snapshots structural Node definitions before they can be mutated", async () => {
  const node = { workerType: "INTERACTION", type: "INTERACTION.OUTPUT" as const,
    execute: async ({ message }: { message: import("../src/index.js").Message }) => message,
  };
  const worker = extendWorker("INTERACTION", { nodes: { OUTPUT: node } });
  node.workerType = "other";
  node.execute = async () => { throw new Error("mutated handler must not execute"); };
  const runtime = createDitto({ workers: [worker] });
  const message = { role: "user" as const, content: "original" };
  try { assert.equal(await runtime.invoke("INTERACTION.OUTPUT", { message }), message); }
  finally { await runtime.close(); }
});
