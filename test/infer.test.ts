import assert from "node:assert/strict";
import test from "node:test";
import { createDitto, graph } from "../src/index.js";
import { createInfer, createInferWorker, InMemoryInferCache, type SampleInput, type SampleOutput, type ModelProvider, type TrajectoryInput, type InferStreamEvent } from "../src/worker/infer/index.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

const sampleInput: SampleInput = { messages: [{ role: "user", content: "Solve this" }], model: { model: "test" } };
const trajectory = (name = "cot"): TrajectoryInput => ({ ...sampleInput, strategy: { name, ...(name === "cot" ? { options: { rounds: 2 } } : {}) } });
const answer = (content = "answer", tokens?: number): SampleOutput => ({ message: { role: "assistant", content }, finishReason: "stop", ...(tokens === undefined ? {} : { usage: { inputTokens: 1, outputTokens: tokens - 1, totalTokens: tokens } }) });
function queued(outputs: SampleOutput[]): { providers: Record<string, ModelProvider>; requests: SampleInput[] } {
  const requests: SampleInput[] = [];
  return { requests, providers: { test: { async invoke(input) { requests.push(structuredClone(input)); const output = outputs.shift(); assert.ok(output, "Unexpected model call"); return output; } } } };
}
const toolRequest = (id = "call-1"): SampleOutput => ({ message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id, name: "lookup", arguments: { query: "hello" } }] });
const actions = [{ name: "lookup", inputSchema: { type: "object" } }];

test("SAMPLE preserves configuration and usage, selects adapters and returns uniform errors", async () => {
  const q = queued([answer("hello", 5), toolRequest()]); const infer = createInfer(q);
  const input: SampleInput = { ...sampleInput, generation: { temperature: 0.7, maxTokens: 100, topK: 2, topP: 0.9, seed: 42, stop: ["END"] }, metadata: { trace: "a" } };
  const result = await infer.reasoning.sample(input);
  assert.equal(result.status, "success"); assert.ok(result.executionId); assert.equal(result.node, "INFER.REASONING.SAMPLE"); assert.equal(result.output?.usage?.totalTokens, 5);
  assert.deepEqual(q.requests[0], input);
  const tool = await infer.reasoning.sample({ ...sampleInput, actions });
  assert.equal("target" in (tool.output?.actionRequests?.[0] ?? {}), false);
  assert.equal((await infer.execute("INFER.CACHE", {})).error?.code, "UNKNOWN_NODE");
  assert.equal((await createInfer().reasoning.sample(sampleInput)).error?.code, "PROVIDER_NOT_FOUND");
  const bad = await infer.execute("INFER.REASONING.SAMPLE", { ...sampleInput, generation: { temperature: NaN } });
  assert.equal(bad.error?.code, "INVALID_INPUT");
  assert.equal((await createInfer(queued([toolRequest()])).reasoning.sample(sampleInput)).error?.code, "UNDECLARED_ACTION");
  const invalid = createInfer({ providers: { a: { invoke: async () => ({ ...answer(), usage: { totalTokens: -1 } }) } } });
  assert.equal((await invalid.reasoning.sample(sampleInput)).error?.code, "INVALID_MODEL_OUTPUT");
});

test("SAMPLE streaming yields genuine deltas, one terminal result and closes on consumer exit", async () => {
  let closed = false; let signal: AbortSignal | undefined;
  const infer = createInfer({ providers: { a: {
    invoke: async () => { throw new Error("Stream must use adapter.stream"); },
    async *stream(_input, options) { signal = options.signal; try { yield { type: "text_delta", delta: "hel" }; yield { type: "text_delta", delta: "lo" }; yield { type: "result", output: answer("hello") }; } finally { closed = true; } },
  } } });
  const events = await collect(infer.reasoning.sample.stream(sampleInput));
  assert.deepEqual(events.map(e => e.type), ["start", "text_delta", "text_delta", "result"]);
  const end = events.at(-1)!; assert.equal(end.type, "result"); if (end.type === "result") assert.equal(end.result.output?.message.content, "hello");
  assert.equal(new Set(events.map(e => e.executionId)).size, 1); assert.ok(closed);
  closed = false;
  for await (const event of infer.reasoning.sample.stream(sampleInput)) { if (event.type === "text_delta") break; }
  assert.ok(signal?.aborted); await new Promise(resolve => setImmediate(resolve)); assert.ok(closed);
});

test("invalid streams fail terminally; non-streaming adapters emit a single complete text delta", async () => {
  const bad = createInfer({ providers: { a: { invoke: async () => answer(), async *stream() { yield { type: "text_delta", delta: "unfinished" }; } } } });
  const events = await collect(bad.reasoning.sample.stream(sampleInput));
  const last = events.at(-1)!; assert.equal(last.type, "result"); if (last.type === "result") assert.equal(last.result.error?.code, "INVALID_MODEL_OUTPUT");
  const fallback = await collect(createInfer(queued([answer()])).reasoning.sample.stream(sampleInput));
  assert.deepEqual(fallback.map(e => e.type), ["start", "text_delta", "result"]);
});

test("trajectory budgets stop before extra model calls", async () => {
  const steps = queued([answer("draft", 4)]);
  const limited = await createInfer(steps).reasoning.trajectory({ ...trajectory("cot"), constraints: { maxSteps: 1 } });
  assert.equal(limited.output?.stopReason, "max_steps"); assert.equal(steps.requests.length, 1);
  const tokens = queued([answer("draft", 10)]);
  const total = await createInfer(tokens).reasoning.trajectory({ ...trajectory("cot"), constraints: { maxTotalTokens: 10 } });
  assert.equal(total.output?.stopReason, "max_tokens"); assert.equal(total.output?.usage?.totalTokens, 10); assert.equal(tokens.requests[0]?.generation?.maxTokens, 10);
  const truncated = await createInfer(queued([{ ...answer("short"), finishReason: "length" }])).reasoning.trajectory(trajectory());
  assert.equal(truncated.output?.stopReason, "max_tokens");
});

test("ReAct and plan-and-act are Runtime flows, not INFER strategies", async () => {
  const infer = createInfer();
  for (const name of ["react", "plan-and-act", "missing"]) assert.equal((await infer.reasoning.trajectory(trajectory(name))).error?.code, "UNKNOWN_STRATEGY");
  assert.equal((await infer.execute("INFER.REASONING.TRAJECTORY", { ...trajectory(), actions })).error?.code, "INVALID_INPUT");
});

test("deadline and caller cancellation terminate uncooperative providers with partial trajectories", async () => {
  const never: ModelProvider = { invoke: async () => new Promise(() => {}) };
  const infer = createInfer({ providers: { slow: never }, timeoutMs: 20 });
  assert.equal((await infer.reasoning.sample(sampleInput)).status, "timeout");
  let calls = 0;
  const partial = createInfer({ providers: { slow: { invoke: async () => ++calls === 1 ? answer("draft") : new Promise(() => {}) } }, timeoutMs: 25 });
  const out = await partial.reasoning.trajectory({ ...trajectory("cot"), constraints: { timeoutMs: 10 } });
  assert.equal(out.status, "timeout"); assert.equal(out.output?.result.content, "draft"); assert.equal(out.output?.stopReason, "timeout");
  const controller = new AbortController(); const job = infer.reasoning.sample(sampleInput, { signal: controller.signal }); controller.abort("user-stop");
  assert.equal((await job).status, "cancelled");
  const pre = new AbortController(); pre.abort(); assert.equal((await infer.reasoning.sample(sampleInput, { signal: pre.signal })).status, "cancelled");
  assert.equal((await infer.reasoning.sample(sampleInput, { timeoutMs: -1 })).error?.code, "INVALID_INPUT");
});

test("trajectory streaming preserves step ordering, result identity and summed usage", async () => {
  const infer = createInfer(queued([answer("draft", 3), answer("final", 4)]));
  const events: InferStreamEvent<unknown>[] = await collect(infer.reasoning.trajectory.stream(trajectory("cot")));
  assert.deepEqual(events.map(e => e.type), ["start", "text_delta", "step", "text_delta", "step", "step", "result"]);
  const result = events.at(-1)!; assert.equal(result.type, "result");
  if (result.type === "result") { const output = result.result.output as { usage: { totalTokens: number }; result: { content: string } }; assert.equal(output.usage.totalTokens, 7); assert.equal(output.result.content, "final"); }
});

test("built-in strategies perform distinct refinement, branch selection and merging", async () => {
  for (const name of ["cot", "long-cot"]) {
    const q = queued(Array.from({ length: name === "long-cot" ? 4 : 2 }, (_, i) => answer(String(i))));
    const result = await createInfer(q).reasoning.trajectory(trajectory(name));
    assert.equal(result.output?.status, "completed", name); assert.equal(q.requests.length, name === "long-cot" ? 4 : 2);
  }
  for (const name of ["tot", "got"]) {
    const selectedCandidateIds = name === "tot" ? ["0:0:1"] : ["0", "1"];
    const decision = { result: { role: "assistant", content: "merged" }, ...(name === "tot" ? { selectedCandidateIds } : {}), decisionSummary: "judged" };
    const q = queued([answer("a"), answer("b"), answer(JSON.stringify(decision))]);
    const result = await createInfer(q).reasoning.trajectory({ ...trajectory(name), strategy: { name, options: { breadth: 2, depth: 1, candidates: 2 } } });
    assert.equal(result.output?.status, "completed", name); assert.equal(result.output?.result.content, name === "tot" ? "b" : "merged"); assert.equal(q.requests.length, 3);
    assert.ok(result.output?.steps.some(s => s.type === "decision"));
  }
});

test("REFLECT validates critique, verify and revision output and never trusts model-supplied usage", async () => {
  for (const mode of ["critique", "verify", "revise"] as const) {
    const response = { assessment: { passed: false, summary: "has issue" }, issues: [{ severity: "warning", description: "fix" }], ...(mode === "revise" ? { revisedResult: { role: "assistant", content: "fixed" } } : {}), usage: { totalTokens: 999 } };
    const result = await createInfer(queued([answer(JSON.stringify(response), 5)])).reasoning.reflect({ target: { artifact: { value: 1 } }, mode, model: sampleInput.model });
    assert.equal(result.status, "success"); assert.equal(result.output?.usage?.totalTokens, 5);
  }
  for (const content of ["not json", JSON.stringify({ assessment: { summary: "missing passed" }, issues: [] })]) {
    const result = await createInfer(queued([answer(content)])).reasoning.reflect({ target: { result: answer().message }, mode: "verify", model: sampleInput.model });
    assert.equal(result.error?.code, "INVALID_MODEL_OUTPUT");
  }
});

test("DELIBERATE selection retains exact candidate content and rejects invented candidate IDs", async () => {
  const candidates = [{ id: "a", result: answer("original").message }, { id: "b", result: answer("second").message }];
  const response = { result: answer("model altered").message, selectedCandidateIds: ["a"] };
  const result = await createInfer(queued([answer(JSON.stringify(response))])).reasoning.deliberate({ candidates, mode: "select", model: sampleInput.model });
  assert.equal(result.output?.result.content, "original");
  const invalid = { ...response, selectedCandidateIds: ["unknown"] };
  assert.equal((await createInfer(queued([answer(JSON.stringify(invalid))])).reasoning.deliberate({ candidates, mode: "select", model: sampleInput.model })).error?.code, "INVALID_MODEL_OUTPUT");
  for (const mode of ["merge", "consensus", "debate"] as const) {
    const output = await createInfer(queued([answer(JSON.stringify({ result: answer(mode).message }))])).reasoning.deliberate({ candidates, mode, model: sampleInput.model });
    assert.equal(output.output?.result.content, mode);
  }
});

test("cache isolates namespaces/scopes and value snapshots, enforces TTL and counts live invalidations", async () => {
  let now = 10; const cache = new InMemoryInferCache({ now: () => now, maxEntries: 3 }); const infer = createInfer({ cache });
  const key = { namespace: "n", scope: "sample", key: "k" }; const value = { nested: { a: 1 } };
  assert.equal((await infer.cache.write({ key, value, ttlMs: 10, tags: ["t"] })).output?.written, true); value.nested.a = 99;
  const hit = await infer.cache.lookup({ key }); assert.deepEqual(hit.output?.value, { nested: { a: 1 } }); (hit.output?.value as typeof value).nested.a = 50;
  assert.deepEqual((await infer.cache.lookup({ key })).output?.value, { nested: { a: 1 } });
  await infer.cache.write({ key: { ...key, scope: "trajectory" }, value: 2, tags: ["t"] });
  await infer.cache.write({ key: { ...key, namespace: "other" }, value: 3 });
  assert.equal((await infer.cache.lookup({ key: { ...key, scope: "reflection" } })).output?.hit, false);
  now = 20; assert.equal((await infer.cache.lookup({ key })).output?.hit, false);
  assert.equal((await infer.cache.invalidate({ selector: { type: "tag", tag: "t" } })).output?.invalidated, 1);
  assert.equal((await infer.cache.invalidate({ selector: { type: "namespace", namespace: "other" } })).output?.invalidated, 1);
  await infer.cache.write({ key, value: undefined }); assert.equal((await infer.cache.lookup({ key })).output?.hit, true);
  assert.equal((await infer.cache.invalidate({ selector: { type: "key", key } })).output?.invalidated, 1);
  await infer.cache.write({ key, value: 1, ttlMs: 0 }); assert.equal((await infer.cache.lookup({ key })).output?.hit, false);
  assert.equal((await infer.cache.write({ key, value: 1, ttlMs: -1 })).error?.code, "INVALID_INPUT");
});

test("bounded cache evicts least recently read entries and tuple keys do not collide", async () => {
  const infer = createInfer({ cache: new InMemoryInferCache({ maxEntries: 2 }) });
  const a = { namespace: "a:b", scope: "c", key: "d" }; const b = { namespace: "a", scope: "b:c", key: "d" }; const c = { scope: "s", key: "c" };
  await infer.cache.write({ key: a, value: 1 }); await infer.cache.write({ key: b, value: 2 }); await infer.cache.lookup({ key: a }); await infer.cache.write({ key: c, value: 3 });
  assert.equal((await infer.cache.lookup({ key: b })).output?.hit, false); assert.equal((await infer.cache.lookup({ key: a })).output?.value, 1);
});

test("Runtime Graph sees typed result envelopes, caches are isolated per replica unless shared", async () => {
  const definition = createInferWorker(queued([answer()])); const runtime = createDitto({ workers: [definition] });
  try {
    assert.deepEqual(runtime.workers()[0]?.capabilities, ["INFER.REASONING.SAMPLE", "INFER.REASONING.TRAJECTORY", "INFER.REASONING.REFLECT", "INFER.REASONING.DELIBERATE", "INFER.CACHE.LOOKUP", "INFER.CACHE.WRITE", "INFER.CACHE.INVALIDATE"]);
    const plan = graph<SampleInput>().node("sample", "INFER.REASONING.SAMPLE", [], input => input);
    assert.equal((await runtime.run(plan, sampleInput)).sample.status, "success");
    const key = { scope: "sample", key: "k" }; await runtime.invoke("INFER.CACHE.WRITE", { key, value: 1 });
    runtime.register(definition); await runtime.invoke("INFER.CACHE.LOOKUP", { key });
    assert.equal((await runtime.invoke("INFER.CACHE.LOOKUP", { key })).output?.hit, false);
  } finally { await runtime.close(); }
  const shared = new InMemoryInferCache(); const r = createDitto({ workers: [createInferWorker({ cache: shared }), createInferWorker({ cache: shared })] });
  try { const key = { scope: "sample", key: "k" }; await r.invoke("INFER.CACHE.WRITE", { key, value: 1 }); await r.invoke("INFER.CACHE.LOOKUP", { key }); assert.equal((await r.invoke("INFER.CACHE.LOOKUP", { key })).output?.hit, true); }
  finally { await r.close(); }
});

test("token budgets reject missing accounting and partial failures retain provider error details", async () => {
  const noUsage = await createInfer(queued([answer()])).reasoning.trajectory({ ...trajectory(), constraints: { maxTotalTokens: 10 } });
  assert.equal(noUsage.status, "failed"); assert.equal(noUsage.error?.code, "USAGE_UNAVAILABLE"); assert.equal(noUsage.output?.steps.length, 1);
  const malformed = createInfer({ providers: { a: { invoke: async () => ({ ...answer(), finishReason: "unknown" } as unknown as SampleOutput) } } });
  const failed = await malformed.reasoning.trajectory(trajectory());
  assert.equal(failed.error?.code, "INVALID_MODEL_OUTPUT"); assert.equal(failed.output?.stopReason, "error");
});

test("provider timeouts preserve the trajectory timeout reason and Worker config is validated upfront", async () => {
  const infer = createInfer({ providers: { a: { invoke: async () => { throw new DOMException("provider deadline", "TimeoutError"); } } } });
  const result = await infer.reasoning.trajectory(trajectory());
  assert.equal(result.status, "timeout"); assert.equal(result.output?.stopReason, "timeout"); assert.equal(result.error?.code, "TIMEOUT");
  assert.throws(() => createInferWorker({ timeoutMs: -1 }), /timeoutMs/);
});

test("lazy cache cleanup removes expired entries before evicting live LRU entries", async () => {
  let now = 0; const cache = new InMemoryInferCache({ maxEntries: 2, now: () => now });
  const key = (key: string) => ({ scope: "s", key });
  await cache.write({ key: key("live"), value: 1 });
  await cache.write({ key: key("expired"), value: 2, ttlMs: 1 });
  now = 2;
  await cache.write({ key: key("new"), value: 3 });
  assert.equal((await cache.lookup({ key: key("live") })).hit, true);
  assert.equal((await cache.lookup({ key: key("expired") })).hit, false);
  await cache.write({ key: key("new"), value: 4, ttlMs: 1 }); now = 4;
  assert.equal((await cache.invalidate({ selector: { type: "key", key: key("new") } })).invalidated, 0);
  assert.equal((await cache.invalidate({ selector: { type: "key", key: key("live") } })).invalidated, 1);
});

test("stream batch draining preserves all buffered deltas and exactly one terminal result", async () => {
  const infer = createInfer({ providers: { a: {
    invoke: async () => answer(),
    async *stream() { for (let i = 0; i < 128; i++) yield { type: "text_delta" as const, delta: String(i) }; yield { type: "result", output: answer() }; },
  } } });
  const deltas: string[] = []; let terminal = 0;
  for await (const event of infer.reasoning.sample.stream(sampleInput)) {
    if (event.type === "start") await new Promise(resolve => setImmediate(resolve));
    if (event.type === "text_delta") deltas.push(event.delta);
    if (event.type === "result") { terminal++; assert.equal(event.result.status, "success"); }
  }
  assert.deepEqual(deltas, Array.from({ length: 128 }, (_, i) => String(i)));
  assert.equal(terminal, 1);
});

test("ToT retains multiple parents, expands the lower-ranked branch, and judges against original messages", async () => {
  const pick = (ids: string[]) => answer(JSON.stringify({ result: answer("judge text must not replace candidate").message, selectedCandidateIds: ids }));
  const q = queued([answer("first"), answer("second"), pick(["0:0:0", "0:0:1"]), answer("first-a"), answer("first-b"), answer("second-a"), answer("second-b correct"), pick(["1:1:1"])]);
  const result = await createInfer(q).reasoning.trajectory({ ...sampleInput, strategy: { name: "tot", options: { breadth: 2, depth: 2, beamWidth: 2 } } });
  assert.equal(result.output?.status, "completed"); assert.equal(result.output?.result.content, "second-b correct"); assert.equal(q.requests.length, 8);
  assert.ok(q.requests[5]?.messages.some(m => m.content === "second"));
  assert.ok(!q.requests[5]?.messages.some(m => m.content === "first"));
  const judging = JSON.parse(String(q.requests[2]?.messages.at(-1)?.content)) as { messages: unknown; selectCount: number };
  assert.deepEqual(judging.messages, sampleInput.messages); assert.equal(judging.selectCount, 2);
  const steps = result.output!.steps; const second = steps.find(s => s.message?.content === "second")!;
  assert.ok(steps.filter(s => s.parentIds?.includes(second.id)).length >= 3);
});

test("GoT aggregates all contributions and feeds the merge back into the next graph layer", async () => {
  const merge = (value: string) => answer(JSON.stringify({ result: answer(value).message }));
  const q = queued([answer("part-a"), answer("part-b"), merge("combined"), answer("improved-a"), answer("improved-b"), merge("final")]);
  const result = await createInfer(q).reasoning.trajectory({ ...sampleInput, strategy: { name: "got", options: { breadth: 2, depth: 2 } } });
  assert.equal(result.output?.result.content, "final"); assert.equal(q.requests.length, 6);
  assert.ok(q.requests[3]?.messages.some(m => m.content === "combined"));
  const aggregations = result.output!.steps.filter(s => s.type === "model" && s.parentIds?.length === 2);
  assert.equal(aggregations.length, 2);
  for (const step of result.output!.steps) for (const id of step.parentIds ?? []) assert.ok(result.output!.steps.find(s => s.id === id)!.index < step.index);
});

test("CoT uses a solution and finalization pass by default; long CoT preserves alternating public history", async () => {
  const single = queued([answer("intermediate"), answer("final")]);
  assert.equal((await createInfer(single).reasoning.trajectory({ ...sampleInput, strategy: { name: "cot" } })).output?.result.content, "final");
  assert.equal(single.requests.length, 2);
  const long = queued([answer("decomposition"), answer("intermediate"), answer("verified"), answer("final")]);
  const result = await createInfer(long).reasoning.trajectory({ ...sampleInput, strategy: { name: "long-cot" } });
  assert.equal(result.output?.status, "completed"); assert.equal(long.requests.length, 4);
  assert.deepEqual(long.requests[3]?.messages.map(m => m.role), ["user", "user", "assistant", "user", "assistant", "user", "assistant", "user"]);
  assert.equal(result.output?.steps.filter(s => s.parentIds?.length === 1).length, 3);
});

test("self-consistency votes on independent final answers without a judge, rejecting ties", async () => {
  const q = queued([answer('{"answer":"391"}'), answer('{"answer":"400"}'), answer('{"answer":"391"}')]);
  const result = await createInfer(q).reasoning.trajectory({ ...sampleInput, strategy: { name: "self-consistency" } });
  assert.equal(result.output?.result.content, "391"); assert.equal(q.requests.length, 3);
  assert.deepEqual(q.requests[0]?.messages, q.requests[1]?.messages);
  const tie = queued([answer('{"answer":"391"}'), answer('{"answer":"400"}')]);
  assert.equal((await createInfer(tie).reasoning.trajectory({ ...sampleInput, strategy: { name: "self-consistency", options: { candidates: 2 } } })).error?.code, "NO_CONSENSUS");
});

test("trajectory does not replace the latest candidate with truncated judging JSON", async () => {
  const q = queued([answer("candidate-a"), answer("candidate-b"), { ...answer('{"result":'), finishReason: "length" }]);
  const result = await createInfer(q).reasoning.trajectory({ ...sampleInput, strategy: { name: "tot", options: { breadth: 2, depth: 1 } } });
  assert.equal(result.output?.stopReason, "max_tokens"); assert.equal(result.output?.result.content, "candidate-b");
});

test("self-consistency treats JSON key ordering as the same answer, without merging different values", async () => {
  const q = queued([answer(JSON.stringify({ answer: '{"a":1,"b":2}' })), answer(JSON.stringify({ answer: '{ "b": 2, "a": 1 }' })), answer(JSON.stringify({ answer: '{"a":9,"b":2}' }))]);
  const result = await createInfer(q).reasoning.trajectory({ ...sampleInput, strategy: { name: "self-consistency" } });
  assert.equal(result.output?.result.content, '{"a":1,"b":2}');
});
