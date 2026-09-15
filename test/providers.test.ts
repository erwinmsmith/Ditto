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
    model: "model-a", input: { messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(output.message.content, "ok");
  assert.deepEqual(requestBody, { model: "model-a", messages: [{ role: "user", content: "hello" }] });
});
