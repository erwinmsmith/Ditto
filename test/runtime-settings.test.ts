import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDitto, loadRuntimeConfig, loadRuntimeConfigFile, ProviderRegistry, runReactFlow } from "../src/index.js";
import { createInfer, createInferWorker, type SampleInput, type SampleOutput } from "../src/worker/infer/index.js";

const input: SampleInput = { model: { model: "fixture" }, messages: [{ role: "user", content: "task" }] };
const answer = (content: string): SampleOutput => ({ message: { role: "assistant", content }, finishReason: "stop", usage: { totalTokens: 2 } });

test("YAML validates startup configuration, rejects typos, credentials, aliases and old env knobs", () => {
  const root = loadRuntimeConfigFile("ditto.yaml", {});
  assert.equal(root.infer.strategies?.tot?.depth, 2);
  assert.equal(root.infer.generation?.maxTokens, 4096);
  assert.deepEqual(root.providers, Object.create(null)); // YAML never enables a provider or loads .env.
  const dir = mkdtempSync(join(tmpdir(), "ditto-config-"));
  const path = join(dir, "config.yaml");
  try {
    for (const yaml of ["infer:\n  strategies:\n    tot:\n      depth: 0", "infer:\n  strategies:\n    got:\n      depht: 2", "infer:\n  generation:\n    maxTokens: -1", "providers:\n  x:\n    apiKey: secret", "runtime:\n  timeoutMs: 2147483648", "runtime: []", "runtime: {maxTurns: 1, maxTurns: 2}", "runtime: &x {maxTurns: 2}\nreact: *x", "", "infer: null"]) {
      writeFileSync(path, yaml); assert.throws(() => loadRuntimeConfigFile(path, {}), yaml);
    }
    assert.throws(() => loadRuntimeConfigFile(join(dir, "missing.yaml"), {}), /ENOENT/);
    for (const key of ["DITTO_TIMEOUT_MS", "DITTO_MAX_TURNS", "DITTO_PROVIDER_X_OPTIONS", "DITTO_PROVIDER_X_MAX_TOKENS_FIELD"]) assert.throws(() => loadRuntimeConfig({ [key]: "private" }), /moved to ditto.yaml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared defaults govern SDK, Worker, nested calls and request overrides without mutation", async () => {
  const settings = { infer: { generation: { temperature: 0.4, maxTokens: 20 }, constraints: { maxSteps: 5, maxTotalTokens: 30 }, strategies: { cot: { rounds: 3 } } } };
  const config = loadRuntimeConfig({}, settings);
  settings.infer.strategies.cot.rounds = 1;
  assert.equal(config.infer.strategies?.cot?.rounds, 3);
  assert.ok(Object.isFrozen(config.infer.strategies?.cot));
  const requests: SampleInput[] = [];
  const runtime = createDitto({ config, providers: new ProviderRegistry({ fixture: { invoke: async request => { requests.push(request); return answer("ok"); } } }), workers: [createInferWorker()] });
  const sdk = createInfer({ runtime });
  try {
    for (const invoke of [sdk.reasoning.trajectory, (value: Parameters<typeof sdk.reasoning.trajectory>[0]) => runtime.invoke("INFER.REASONING.TRAJECTORY", value)]) {
      requests.length = 0;
      assert.equal((await invoke({ ...input, strategy: { name: "cot" } })).output?.status, "completed");
      assert.equal(requests.length, 3);
      assert.ok(requests.every(r => r.generation?.maxTokens === 20 && r.generation.temperature === 0.4));
      requests.length = 0;
      const request = { ...input, strategy: { name: "cot", options: { rounds: 2 } }, generation: { maxTokens: 7 } };
      assert.equal((await invoke(request)).output?.status, "completed");
      assert.equal(requests.length, 2); assert.equal(requests[0]?.generation?.maxTokens, 7); assert.equal(requests[0]?.generation?.temperature, 0.4);
      assert.deepEqual(request.strategy.options, { rounds: 2 });
      const limited = await invoke({ ...input, strategy: { name: "cot" }, constraints: { maxSteps: 1 } });
      assert.equal(limited.output?.stopReason, "max_steps");
    }
    requests.length = 0;
    await sdk.reasoning.sample(input); assert.equal(requests[0]?.generation?.maxTokens, 20);
    const flow = await runReactFlow(runtime, input); assert.equal(flow.status, "completed"); assert.equal(requests[1]?.generation?.maxTokens, 20);
  } finally { await runtime.close(); }
});

test("configured ToT and GoT depth changes execution and total-token limits cap nested sampling", async () => {
  for (const name of ["tot", "got"] as const) for (const depth of [1, 2]) {
    const requests: SampleInput[] = [];
    const responses = [answer("first"), answer(JSON.stringify({ result: answer("merged").message, ...(name === "tot" ? { selectedCandidateIds: ["0:0:0"] } : {}) })), answer("final"), answer(JSON.stringify({ result: answer("merged-final").message, ...(name === "tot" ? { selectedCandidateIds: ["1:0:0"] } : {}) }))];
    const sdk = createInfer({ defaults: { generation: { maxTokens: 10 }, constraints: { maxSteps: 4, maxTotalTokens: 8 }, strategies: { [name]: { breadth: 1, depth: 1 } } }, providers: { fixture: { invoke: async request => { requests.push(request); return responses.shift()!; } } } });
    const result = await sdk.reasoning.trajectory({ ...input, strategy: { name, ...(depth === 2 ? { options: { depth } } : {}) } });
    assert.equal(result.output?.status, "completed", result.error?.message);
    assert.equal(requests.length, depth * 2); assert.deepEqual(requests.map(r => r.generation?.maxTokens), [8, 6, 4, 2].slice(0, depth * 2));
    assert.equal(result.output?.result.content, name === "tot" ? depth === 1 ? "first" : "final" : depth === 1 ? "merged" : "merged-final");
  }
});

test("configured trajectory timeout applies even without request constraints", async () => {
  const sdk = createInfer({ defaults: { constraints: { timeoutMs: 10 } }, providers: { slow: { invoke: () => new Promise(() => {}) } } });
  const result = await sdk.reasoning.trajectory({ ...input, strategy: { name: "cot" } });
  assert.equal(result.status, "timeout"); assert.equal(result.output?.stopReason, "timeout");
});
