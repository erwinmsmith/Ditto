import assert from "node:assert/strict";
import test from "node:test";
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import type { InteractionOutputInput } from "@codesoul-co/ditto/worker/interaction";
import { createInferWorker, type SampleInput, type SampleOutput } from "@codesoul-co/ditto/worker/infer";
import { runPipeline } from "../examples/control-flow/sequence/pipeline.js";
import { dependenciesGraph, dependenciesInput, runDependencies } from "../examples/control-flow/sequence/dependencies.js";
import { runStages } from "../examples/control-flow/sequence/stages.js";
import { runBatch } from "../examples/control-flow/sequence/batch.js";

test("sequence pipeline passes caller data through LOAD and SELECT without changing it", async () => {
  const items = [
    { id: "alpha", content: "alpha topic" },
    { id: "beta", content: "beta topic" },
  ];
  const before = structuredClone(items);
  const result = await runPipeline({ items, query: "alpha", limit: 1 });
  assert.deepEqual(result.loaded.items, before);
  assert.deepEqual(result.selected.selectedItemIds, ["alpha"]);
  assert.deepEqual(items, before);
  const empty = await runPipeline({ items: [], query: "alpha", limit: 1 });
  assert.deepEqual(empty.selected.selectedItemIds, []);
  const none = await runPipeline({ items, query: "alpha", limit: 0 });
  assert.deepEqual(none.selected.selectedItemIds, []);
});

test("sequence dependencies deliver both original and updated data with caller-owned IDs", async () => {
  const input = {
    items: [{ id: "original", content: "source material" }],
    additions: [{ id: "new", content: "additional evidence" }],
    query: "evidence", limit: 1, deliveryId: "custom-delivery",
  };
  const before = structuredClone(input);
  const result = await runDependencies(input);
  assert.deepEqual(result.loaded.items, input.items);
  assert.deepEqual(result.updated.items.map(item => item.id), ["original", "new"]);
  assert.deepEqual(result.deliveries, [{
    deliveryId: "custom-delivery",
    message: { role: "assistant", content: {
      originalItemIds: ["original"], selectedItemIds: ["new"], selectedContent: ["additional evidence"],
    } },
  }]);
  assert.deepEqual(result.delivered, { deliveryId: "custom-delivery", status: "accepted" });
  assert.deepEqual(input, before);
});

test("invalid selection stops the sequence before the output sink is called", async () => {
  let delivered = 0;
  const runtime = createDitto({ workers: [
    createContextWorker(),
    createInteractionWorker({ output: { async deliver(input) {
      delivered++;
      return { deliveryId: input.deliveryId, status: "accepted" };
    } } }),
  ] });
  try {
    await assert.rejects(runtime.run(dependenciesGraph, { ...dependenciesInput, limit: -1 }), /limit/);
    assert.equal(delivered, 0);
  } finally { await runtime.close(); }
});

// Deterministic regression coverage; real HTTP models run in check:examples:sequence:live.
function unitRuntime(responses: readonly SampleOutput[]) {
  const calls: SampleInput[] = [];
  const deliveries: InteractionOutputInput[] = [];
  const runtime = createDitto({ workers: [
    createContextWorker(),
    createInferWorker({ providers: { unit: { async invoke(input) {
      calls.push(input);
      const response = responses[calls.length - 1];
      if (!response) throw new Error("Unexpected extra model call");
      return response;
    } } } }),
    createInteractionWorker({ output: { async deliver(input) {
      deliveries.push(input);
      return { deliveryId: input.deliveryId, status: "accepted" };
    } } }),
  ] });
  return { runtime, calls, deliveries };
}
const unitModel = { provider: "unit", model: "unit" };
const response = (value: unknown): SampleOutput => ({
  message: { role: "assistant", content: JSON.stringify(value) }, finishReason: "stop",
});

test("stages validate preparation and pass its actual result to the next Graph", async () => {
  const order = { code: "ORDER-abc", quantity: 4, unitPriceCents: 125 };
  const { runtime, calls, deliveries } = unitRuntime([response(order), response({ code: order.code, totalCents: 500 })]);
  try {
    const result = await runStages(runtime, { id: "job", text: "unstructured order", model: unitModel });
    assert.deepEqual(result.order, order);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1]?.messages[1]?.content)), order);
    assert.deepEqual(deliveries.map(item => item.message.content), [{ code: order.code, totalCents: 500 }]);
  } finally { await runtime.close(); }
});

test("invalid preparation prevents the next stage; incorrect completion prevents delivery", async () => {
  for (const [responses, expectedCalls, error] of [
    [[response({ code: "X", quantity: -1, unitPriceCents: 100 })], 1, /Invalid prepared order/],
    [[response({ code: "X", quantity: 2, unitPriceCents: 100 }), response({ code: "X", totalCents: 1 })], 2, /summary does not match/],
  ] as const) {
    const { runtime, calls, deliveries } = unitRuntime(responses);
    try {
      await assert.rejects(runStages(runtime, { id: "job", text: "order", model: unitModel }), error);
      assert.equal(calls.length, expectedCalls);
      assert.equal(deliveries.length, 0);
    } finally { await runtime.close(); }
  }
});

test("batch keeps per-object results in order and handles more than the default 32 Loop iterations", async () => {
  const items = Array.from({ length: 33 }, (_, index) => ({ id: `item-${index}`, text: `record-${index}` }));
  const expected = items.map((item, index) => ({ id: item.id, code: `CODE-${index}`, quantity: index }));
  const { runtime, calls, deliveries } = unitRuntime(expected.map(item => response({ code: item.code, quantity: item.quantity })));
  try {
    const result = await runBatch(runtime, { items, model: unitModel, deliveryId: "batch" });
    assert.deepEqual(result.results, expected);
    assert.equal(result.samples.length, items.length);
    assert.deepEqual(calls.map(call => JSON.parse(String(call.messages[1]?.content))[0].id), items.map(item => item.id));
    assert.deepEqual(deliveries.map(item => item.message.content), [{ items: expected, totalQuantity: 528 }]);
  } finally { await runtime.close(); }
});

test("empty batches deliver an empty summary without calling a model", async () => {
  const { runtime, calls, deliveries } = unitRuntime([]);
  try {
    const result = await runBatch(runtime, { items: [], model: unitModel, deliveryId: "empty" });
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.samples, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(deliveries.map(item => item.message.content), [{ items: [], totalQuantity: 0 }]);
  } finally { await runtime.close(); }
});

test("batch validates object IDs before execution and stops at a truncated model response", async () => {
  const { runtime, calls, deliveries } = unitRuntime([
    response({ code: "one", quantity: 1 }),
    { ...response({ code: "two", quantity: 2 }), finishReason: "length" },
    response({ code: "three", quantity: 3 }),
  ]);
  try {
    for (const ids of [["same", "same"], [" "]]) {
      await assert.rejects(runBatch(runtime, {
        items: ids.map(id => ({ id, text: "record" })), model: unitModel, deliveryId: "invalid",
      }), /nonempty and unique/);
    }
    assert.equal(calls.length, 0);
    await assert.rejects(runBatch(runtime, {
      items: ["one", "two", "three"].map(id => ({ id, text: id })), model: unitModel, deliveryId: "failed",
    }), /did not complete/);
    assert.equal(calls.length, 2);
    assert.equal(deliveries.length, 0);
  } finally { await runtime.close(); }
});
