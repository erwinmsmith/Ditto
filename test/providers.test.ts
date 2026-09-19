import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry, Sandbox, createHttpProvider } from "../src/index.js";

test("provider adapters implement the vendor-neutral invoke boundary", async () => {
  let requestBody: unknown;
  const provider = createHttpProvider({
    kind: "openai-compatible",
    baseUrl: "https://provider.test/v1",
    sandbox: new Sandbox(process.cwd(), { network: ["https://provider.test"] }),
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  const registry = new ProviderRegistry();
  registry.register("test", provider);
  const output = await registry.get("test").invoke({
    model: { model: "model-a" }, messages: [{ role: "user", content: "hello" }],
  }, { signal: new AbortController().signal });
  assert.equal(output.message.content, "ok");
  assert.deepEqual(requestBody, { model: "model-a", messages: [{ role: "user", content: "hello" }], stream: false, n: 1 });
});

test("shared config separates provider deployment from behavior and validates token mappings", async () => {
  const { loadRuntimeConfig } = await import("../src/runtime/config.js");
  const env = { DITTO_PROVIDERS: "deepseek", DITTO_PROVIDER_DEEPSEEK_MODEL: "fixture" };
  const settings = { providers: { deepseek: { options: { thinking: { type: "enabled" } }, maxTokensField: "max_tokens" as const } } };
  const provider = loadRuntimeConfig(env, settings).providers.deepseek!;
  assert.equal(provider.model, "fixture"); assert.equal(provider.maxTokensField, "max_tokens"); assert.deepEqual(provider.providerOptions, { thinking: { type: "enabled" } });
  assert.throws(() => loadRuntimeConfig({ ...env, DITTO_PROVIDER_DEEPSEEK_OPTIONS: "private-value" }), error => error instanceof Error && !error.message.includes("private-value"));
  assert.throws(() => loadRuntimeConfig({ ...env, DITTO_PROVIDER_DEEPSEEK_KIND: "gemini" }, settings), /Invalid max tokens field/);
});
