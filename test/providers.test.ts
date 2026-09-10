import assert from "node:assert/strict";
import test from "node:test";
import { createHttpProvider, Sandbox, type ModelMessage } from "../src/index.js";

const history: readonly ModelMessage[] = [
  { role: "system", content: "Be brief" }, { role: "user", content: "hi" },
  { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "echo", arguments: { text: "hi" } }] },
  { role: "tool", toolCallId: "t1", content: "hi" },
];

test("OpenAI-compatible provider preserves tool call IDs, arguments and secrets only in auth headers", async () => {
  const adapter = createHttpProvider({ kind: "openai-compatible", baseUrl: "https://models.test/v1", apiKey: "test-secret",
    sandbox: new Sandbox(process.cwd(), { network: ["https://models.test"] }),
    fetch: async (url, init) => {
      assert.equal(url, "https://models.test/v1/chat/completions");
      assert.equal((init!.headers as Record<string, string>).authorization, "Bearer test-secret");
      assert.equal(init!.redirect, "error");
      const body = JSON.parse(init!.body as string);
      assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"text":"hi"}');
      assert.equal(body.messages[3].tool_call_id, "t1");
      assert.equal((init!.body as string).includes("test-secret"), false);
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "t2", type: "function", function: { name: "echo", arguments: '{"text":"again"}' } }] } }] });
    },
  });
  assert.deepEqual(await adapter.generate({ model: "model", messages: history }), {
    content: "", toolCalls: [{ id: "t2", name: "echo", arguments: { text: "again" } }],
  });
});

test("Anthropic adapter maps tools, system instructions and grouped tool results", async () => {
  const adapter = createHttpProvider({ kind: "anthropic", baseUrl: "https://models.test/v1", apiKey: "test-secret",
    sandbox: new Sandbox(process.cwd(), { network: ["https://models.test"] }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      assert.equal(body.system, "Be brief");
      assert.equal(body.messages[1].content[0].type, "tool_use");
      assert.equal(body.messages[2].content[0].tool_use_id, "t1");
      assert.equal(body.messages[2].content.length, 2);
      assert.deepEqual(body.tools[0].input_schema, { type: "object" });
      return Response.json({ content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t3", name: "echo", input: {} }] });
    },
  });
  assert.deepEqual(await adapter.generate({ model: "model", messages: [...history, { role: "tool", toolCallId: "t2", content: "there" }],
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }), {
    content: "ok", toolCalls: [{ id: "t3", name: "echo", arguments: {} }],
  });
});

test("provider permission denial prevents fetch; HTTP errors do not expose response secrets", async () => {
  let fetched = false;
  const denied = createHttpProvider({ kind: "openai-compatible", baseUrl: "https://models.test",
    sandbox: new Sandbox(process.cwd()), fetch: async () => { fetched = true; throw new Error("unexpected"); } });
  await assert.rejects(denied.generate({ model: "x", messages: [] }), /Permission denied/); assert.equal(fetched, false);
  const failed = createHttpProvider({ kind: "openai-compatible", baseUrl: "https://models.test",
    sandbox: new Sandbox(process.cwd(), { network: ["https://models.test"] }),
    fetch: async () => new Response("secret-response", { status: 401 }),
  });
  await assert.rejects(failed.generate({ model: "x", messages: [] }), (error: Error) => error.message === "Provider request failed (HTTP 401)");
});
