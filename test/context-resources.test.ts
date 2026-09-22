import assert from "node:assert/strict";
import test from "node:test";
import {
  createContext, createContextOperationQueue, createInMemoryContextStore, ContextError,
} from "../src/index.js";

const scope = { sessionId: "session" };
const hasCode = (code: string) => (error: unknown) => error instanceof ContextError && error.code === code;

test("local Context cache preserves CAS, immutable snapshots, write TTL and bounded LRU", async () => {
  let now = 0;
  const store = createInMemoryContextStore({ ttlMs: 10, maxEntries: 2, now: () => now });
  const input = { items: [{ id: "one", content: "original" }] };
  const initial = await store.compareAndSet(scope, undefined, input);
  input.items[0]!.content = "mutated";
  assert.equal((await store.get(scope))?.context.items[0]?.content, "original");
  assert.ok(Object.isFrozen(initial.context.items[0]));
  await assert.rejects(store.compareAndSet(scope, undefined, input), hasCode("STATE_CONFLICT"));
  const updated = await store.compareAndSet(scope, initial.version, input);
  assert.notEqual(updated.version, initial.version);
  await store.compareAndSet({ sessionId: "b" }, undefined, input);
  await store.get(scope);
  await store.compareAndSet({ sessionId: "c" }, undefined, input);
  assert.equal(await store.get({ sessionId: "b" }), undefined);
  assert.ok(await store.get(scope));
  now = 10;
  assert.equal(await store.get(scope), undefined);
  await assert.rejects(store.compareAndSet(scope, updated.version, input), hasCode("STATE_CONFLICT"));
  await store.compareAndSet(scope, undefined, input);
  for (const options of [{ ttlMs: 0 }, { maxEntries: 0 }, { ttlMs: NaN }]) assert.throws(() => createInMemoryContextStore(options));
});

test("Context scope queue prevents lost updates and permits other scopes while a job waits", async () => {
  const operationQueue = createContextOperationQueue({ maxPending: 40 });
  const sdk = createContext({ services: { operationQueue, stateStore: createInMemoryContextStore() } });
  await sdk.load({ scope, sources: [] });
  await Promise.all(Array.from({ length: 30 }, (_, index) => sdk.update({ scope, add: [{ id: String(index), content: index }] })));
  assert.equal((await sdk.load({ scope })).items.length, 30);
  const gate = Promise.withResolvers<void>();
  const blocked = operationQueue.enqueue(scope, () => gate.promise);
  assert.equal(await operationQueue.enqueue({ sessionId: "other" }, async () => "independent"), "independent");
  gate.resolve(); await blocked;
  await assert.rejects(operationQueue.enqueue(scope, async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await operationQueue.enqueue(scope, async () => "recovered"), "recovered");
});

test("queue capacity includes cancelled waiting jobs until they drain, then becomes reusable", async () => {
  const queue = createContextOperationQueue({ maxPending: 2 });
  const gate = Promise.withResolvers<void>();
  const first = queue.enqueue(scope, () => gate.promise);
  const controller = new AbortController(); let ran = false;
  const cancelled = queue.enqueue(scope, async () => { ran = true; }, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, /cancel queue/);
  controller.abort(new Error("cancel queue"));
  await assert.rejects(queue.enqueue(scope, async () => {}), hasCode("QUEUE_FULL"));
  gate.resolve(); await first; await rejected;
  assert.equal(ran, false);
  await queue.enqueue(scope, async () => {});
});

test("LOAD resolves references only when requested, retains source identity and validates resolved content", async () => {
  let calls = 0;
  const reference = { uri: "file:policy" };
  const sdk = createContext({ services: { referenceResolver: { async resolve(input, options) {
    assert.equal(input.uri, reference.uri); assert.ok(options); calls++; return "resolved policy";
  } } } });
  const preserved = await sdk.load({ sources: [reference] }); assert.equal(calls, 0);
  const resolved = await sdk.load({ sources: [reference], resolveReferences: true });
  assert.equal(calls, 1); assert.equal(resolved.items[0]?.id, preserved.items[0]?.id);
  assert.deepEqual(resolved.items[0]?.source, reference); assert.equal(resolved.items[0]?.content, "resolved policy");
  await assert.rejects(createContext().load({ sources: [reference], resolveReferences: true }), hasCode("RESOLVER_UNAVAILABLE"));
  const large = createContext({ policy: { maxInlineBytes: 4 }, services: { referenceResolver: { async resolve() { return "long text"; } } } });
  await assert.rejects(large.load({ sources: [reference], resolveReferences: true }), hasCode("INLINE_LIMIT_EXCEEDED"));
});

test("cancelled resolution never commits a new cached Context or invokes later resolvers", async () => {
  const controller = new AbortController(); let calls = 0;
  const stateStore = createInMemoryContextStore();
  const sdk = createContext({ services: { stateStore, referenceResolver: { async resolve(_ref, options) {
    assert.equal(options?.signal, controller.signal); calls++;
    controller.abort(new Error("cancel resolution")); return "resolved";
  } } } });
  await assert.rejects(sdk.load({ scope, sources: [{ uri: "urn:a" }, { uri: "urn:b" }], resolveReferences: true }, {
    signal: controller.signal,
  }), /cancel resolution/);
  assert.equal(calls, 1); assert.equal(await stateStore.get(scope), undefined);
});
