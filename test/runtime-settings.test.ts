import { parseEnv } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    for (const yaml of ["workers:\n  infer:\n    strategies:\n      tot:\n        depth: 0", "workers:\n  infer:\n    strategies:\n      got:\n        depht: 2", "workers:\n  infer:\n    generation:\n      maxTokens: -1", "shared:\n  providers:\n    x:\n      apiKey: secret", "runtime:\n  timeoutMs: 2147483648", "runtime: []", "runtime: {maxTurns: 1, maxTurns: 2}", "runtime: &x {maxTurns: 2}\nworkers: *x", "", "workers: {infer: null}", "infer: {}", "providers: {}", "react: {}", "workers: {inferr: {}}", "shared: []", "workers: {infer: {deliberate: {mode: invalid}}}", "workers: {infer: {deliberate: {selectCount: 0}}}", "workers: {infer: {deliberate: {generation: {maxTokens: -1}}}}", "runtime: {react: {maxActionCalls: -1}}"]) {
      writeFileSync(path, yaml); assert.throws(() => loadRuntimeConfigFile(path, {}), yaml);
    }
    assert.throws(() => loadRuntimeConfigFile(join(dir, "missing.yaml"), {}), /ENOENT/);
    for (const key of ["DITTO_TIMEOUT_MS", "DITTO_MAX_TURNS", "DITTO_SHARED_PROVIDER_X_OPTIONS", "DITTO_SHARED_PROVIDER_X_MAX_TOKENS_FIELD"]) assert.throws(() => loadRuntimeConfig({ [key]: "private" }), /moved to ditto.yaml/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("shared defaults govern SDK, Worker, nested calls and request overrides without mutation", async () => {
  const settings = { workers: { infer: { generation: { temperature: 0.4, maxTokens: 20 }, constraints: { maxSteps: 5, maxTotalTokens: 30 }, strategies: { cot: { rounds: 3 } } } } };
  const config = loadRuntimeConfig({}, settings);
  settings.workers.infer.strategies.cot.rounds = 1;
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


test("grouped env and YAML resolve shared resources and Worker defaults; legacy names cannot be ignored", () => {
  const env = parseEnv(readFileSync(".env.example", "utf8"));
  const config = loadRuntimeConfigFile("ditto.yaml", { ...env, DITTO_SHARED_SANDBOX_ALLOW_TOOLS: "lookup" });
  assert.equal(config.environment, "development");
  assert.deepEqual(config.model, { provider: "deepseek", model: "deepseek-flash" });
  assert.equal(config.providers.deepseek?.baseUrl, "https://api.deepseek.com");
  assert.equal(config.providers.deepseek?.maxTokensField, "max_tokens");
  assert.equal(config.providers.deepseek?.apiKey, undefined);
  assert.deepEqual(config.providers.deepseek?.providerOptions, { thinking: { type: "enabled" }, reasoning_effort: "low" });
  assert.deepEqual(config.sandbox.tools, ["lookup"]);
  assert.deepEqual(config.sandbox.network, ["https://api.deepseek.com"]);
  assert.equal(config.react.maxTotalTokens, 64000);
  assert.equal(config.infer.strategies?.got?.depth, 2);
  for (const key of ["DITTO_ENV", "DITTO_WORKSPACE", "DITTO_PROVIDERS", "DITTO_MODEL_PROVIDER", "DITTO_MODEL", "DITTO_ALLOW_NETWORK", "DITTO_PROVIDER_X_API_KEY", "DITTO_WORKER_TOKEN"]) {
    assert.throws(() => loadRuntimeConfig({ ...env, [key]: "private-value" }), error => error instanceof Error && error.message.includes("Legacy env key") && !error.message.includes("private-value"));
  }
});

test("DELIBERATE defaults work through SDK and Worker, with request overrides and validated selection counts", async () => {
  const requests: SampleInput[] = [];
  const config = loadRuntimeConfig({}, { workers: { infer: {
    generation: { maxTokens: 20, temperature: 0.4 },
    deliberate: { mode: "merge", selectCount: 2, generation: { maxTokens: 12 } },
  } } });
  const runtime = createDitto({ config, workers: [createInferWorker()], providers: new ProviderRegistry({ fixture: {
    invoke: async request => {
      requests.push(request);
      const task = JSON.parse(String(request.messages.at(-1)!.content));
      return answer(JSON.stringify({ result: answer("merged").message, ...(task.mode === "select" ? { selectedCandidateIds: task.candidates.slice(0, task.selectCount).map((c: { id: string }) => c.id) } : {}) }));
    },
  } }) });
  const sdk = createInfer({ runtime });
  const candidates = [{ id: "a", result: answer("a").message }, { id: "b", result: answer("b").message }];
  try {
    for (const invoke of [sdk.reasoning.deliberate, (value: Parameters<typeof sdk.reasoning.deliberate>[0]) => runtime.invoke("INFER.REASONING.DELIBERATE", value)]) {
      assert.equal((await invoke({ ...input, candidates })).output?.result.content, "merged");
      assert.equal(requests.at(-1)?.generation?.maxTokens, 12);
      assert.equal(requests.at(-1)?.generation?.temperature, 0.4);
      const selected = await invoke({ ...input, candidates, mode: "select" });
      assert.deepEqual(selected.output?.selectedCandidateIds, ["a", "b"]);
      const request = { ...input, candidates, mode: "select" as const, selectCount: 1, generation: { maxTokens: 5 } };
      assert.deepEqual((await invoke(request)).output?.selectedCandidateIds, ["a"]);
      assert.deepEqual(request.generation, { maxTokens: 5 });
      assert.equal(requests.at(-1)?.generation?.maxTokens, 5);
      const count = requests.length;
      assert.equal((await invoke({ ...input, candidates, mode: "select", selectCount: 3 })).error?.code, "INVALID_INPUT");
      assert.equal((await invoke({ ...input, candidates, mode: "merge", selectCount: 1 })).error?.code, "INVALID_INPUT");
      assert.equal(requests.length, count);
    }
    assert.equal((await sdk.execute("INFER.REASONING.DELIBERATE", { ...input, candidates, generation: null })).error?.code, "INVALID_INPUT");
    const fallback = createInfer({ providers: { fixture: { invoke: async () => answer(JSON.stringify({ result: answer("changed").message, selectedCandidateIds: ["a"] })) } } });
    assert.equal((await fallback.reasoning.deliberate({ ...input, candidates })).output?.result.content, "a");
  } finally { await runtime.close(); }
});

test("ToT/GoT keep their decision modes and retain budget caps with separate DELIBERATE generation defaults", async () => {
  for (const name of ["tot", "got"] as const) {
    const requests: SampleInput[] = [];
    const sdk = createInfer({ defaults: {
      generation: { maxTokens: 20 }, deliberate: { mode: "debate", selectCount: 7, generation: { maxTokens: 7 } },
      strategies: { [name]: { breadth: 2, depth: 1 } },
    }, providers: { fixture: { invoke: async request => {
      requests.push(request);
      if (requests.length % 3 !== 0) return answer("candidate");
      const task = JSON.parse(String(request.messages.at(-1)!.content));
      assert.equal(task.mode, name === "tot" ? "select" : "merge");
      if (name === "tot") assert.equal(task.selectCount, 1);
      return answer(JSON.stringify({ result: answer("merged").message, ...(name === "tot" ? { selectedCandidateIds: ["0:0:0"] } : {}) }));
    } } } });
    for (const explicit of [false, true]) {
      requests.length = 0;
      const result = await sdk.reasoning.trajectory({ ...input, strategy: { name }, ...(explicit ? { generation: { maxTokens: 5 } } : {}) });
      assert.equal(result.output?.status, "completed", result.error?.message);
      assert.deepEqual(requests.map(r => r.generation?.maxTokens), explicit ? [5, 5, 5] : [20, 20, 7]);
    }
    requests.length = 0;
    const limited = await sdk.reasoning.trajectory({ ...input, strategy: { name }, constraints: { maxTotalTokens: 5 } });
    assert.equal(limited.output?.stopReason, "max_tokens");
    assert.deepEqual(requests.map(r => r.generation?.maxTokens), [5, 3, 1]);
  }
});

test("Context behavior settings are immutable and reject invalid cache or policy values", () => {
  const config = loadRuntimeConfig({}, { workers: { context: {
    policy: { maxItems: 12, duplicate: "keep-first" }, cache: { ttlMs: 1000, keyPrefix: "test:" },
  } } });
  assert.equal(config.context.policy?.maxItems, 12);
  assert.ok(Object.isFrozen(config.context.cache));
  for (const context of [{ cache: { ttlMs: 0 } }, { cache: { keyPrefix: "" } }, { policy: { maxItems: -1 } }, { cache: { url: "redis://secret" } }]) {
    assert.throws(() => loadRuntimeConfig({}, { workers: { context } } as never));
  }
});
