import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createDitto, createHttpTransport, createWorkerHttpHandler, Sandbox } from "../src/index.js";
import { createInfer, createInferWorker, createHttpProvider, type SampleInput } from "../src/worker/infer/index.js";

const input: SampleInput = { model: { model: "test-model" }, messages: [{ role: "user", content: "hello" }] };
const sandbox = new Sandbox(process.cwd(), { network: ["https://model.example"] });
const options = { kind: "openai-compatible" as const, baseUrl: "https://model.example/v1", apiKey: "private-key", sandbox };

test("OpenAI adapter maps messages, generation, tools, usage and protects routing fields", async () => {
  let body: Record<string, unknown> = {};
  const fetchMock: typeof fetch = async (url, init) => {
    assert.equal(url, "https://model.example/v1/chat/completions"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-key"); body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call", type: "function", function: { name: "find", arguments: '{"term":"test"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } });
  };
  const infer = createInfer({ providers: { http: createHttpProvider({ ...options, fetch: fetchMock }) } });
  const result = await infer.reasoning.sample({ ...input,
    model: { ...input.model, endpoint: "https://model.example/v1/", providerOptions: { n: 50, model: "override", stream: true, temperature: 1.5, custom: "pass" } },
    messages: [...input.messages, { role: "assistant", content: "", metadata: { actionRequests: [{ id: "prev", name: "find", arguments: {} }] } }, { role: "tool", content: "previous result", metadata: { actionRequestId: "prev" } }],
    generation: { temperature: 0.2, topP: 0.8, topK: 5, maxTokens: 100, seed: 3, stop: ["STOP"] },
    actions: [{ name: "find", inputSchema: { type: "object" }, targetNode: "INTERACTION.ACT" }],
  });
  assert.equal(result.status, "success"); assert.deepEqual(result.output?.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, reasoningTokens: 1 });
  assert.equal(result.output?.actionRequests?.[0]?.targetNode, "INTERACTION.ACT"); assert.deepEqual(result.output?.actionRequests?.[0]?.arguments, { term: "test" });
  assert.equal(body.n, 1); assert.equal(body.model, "test-model"); assert.equal(body.stream, false); assert.equal(body.temperature, 0.2); assert.equal(body.max_completion_tokens, 100); assert.equal(body.custom, "pass");
  const messages = body.messages as Record<string, unknown>[]; assert.equal(messages[2]?.tool_call_id, "prev"); assert.ok(messages[1]?.tool_calls);
});

test("OpenAI SSE handles split UTF-8/CRLF frames, action fragments and terminal usage", async () => {
  const frames = [
    { choices: [{ delta: { content: "你好" }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "id-", type: "function", function: { name: "find", arguments: '{"term":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { arguments: '"中文"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
  ].map(v => `data: ${JSON.stringify(v)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const bytes = new TextEncoder().encode(frames);
  const provider = createHttpProvider({ ...options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; assert.deepEqual(body.stream_options, { include_usage: true });
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
  } });
  const infer = createInfer({ providers: { http: provider } }); const events = [];
  for await (const event of infer.reasoning.sample.stream({ ...input, actions: [{ name: "find", inputSchema: {} }] })) events.push(event);
  const result = events.at(-1)!; assert.equal(result.type, "result");
  if (result.type === "result") {
    assert.equal(result.result.status, "success"); assert.equal(result.result.output?.message.content, "你好");
    assert.deepEqual(result.result.output?.actionRequests, [{ id: "id-1", name: "find", arguments: { term: "中文" } }]); assert.equal(result.result.output?.usage?.totalTokens, 8);
  }
});

test("OpenAI adapter rejects endpoint changes, denied network, malformed responses and truncated SSE", async () => {
  let calls = 0;
  const infer = createInfer({ providers: { a: createHttpProvider({ ...options, fetch: async () => { calls++; return new Response("secret-error", { status: 503 }); } }) } });
  const mismatch = await infer.reasoning.sample({ ...input, model: { ...input.model, endpoint: "https://elsewhere.example/v1" } });
  assert.equal(mismatch.error?.code, "ENDPOINT_MISMATCH"); assert.equal(calls, 0);
  const failed = await infer.reasoning.sample(input); assert.equal(failed.error?.code, "PROVIDER_HTTP_ERROR"); assert.equal(failed.error?.message.includes("secret-error"), false);
  const denied = createInfer({ providers: { a: createHttpProvider({ ...options, sandbox: new Sandbox(process.cwd()), fetch: async () => { throw new Error("must not fetch"); } }) } });
  assert.match((await denied.reasoning.sample(input)).error?.message ?? "", /Permission denied/);
  for (const data of [{ choices: [] }, { choices: [{ message: { content: "x" }, finish_reason: "unexpected" }] }]) {
    const bad = createInfer({ providers: { a: createHttpProvider({ ...options, fetch: async () => Response.json(data) }) } });
    assert.equal((await bad.reasoning.sample(input)).error?.code, "INVALID_MODEL_OUTPUT");
  }
  const truncated = createInfer({ providers: { a: createHttpProvider({ ...options, fetch: async () => new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n') }) } });
  const events = []; for await (const event of truncated.reasoning.sample.stream(input)) events.push(event);
  const last = events.at(-1)!; assert.equal(last.type, "result"); if (last.type === "result") assert.equal(last.result.error?.code, "INCOMPLETE_MODEL_OUTPUT");
});

test("INFER contracts survive the real HTTP transport for SAMPLE and cache results", async () => {
  const remote = createDitto({ hostId: "infer-host", processId: "remote" });
  const worker = createInferWorker({ providers: { a: { invoke: async () => ({ message: { role: "assistant", content: "remote answer" }, finishReason: "stop" }) } } });
  const handle = remote.register(worker); const server = createServer(createWorkerHttpHandler(remote, { token: "fixture" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const local = createDitto({ transports: [createHttpTransport({ id: "http", token: "fixture", url: `http://127.0.0.1:${address.port}/ditto/invoke` })] });
  local.registerRemote({ address: handle.address, capabilities: worker.capabilities, transportId: "http" });
  try {
    const output = await local.invoke("INFER.REASONING.SAMPLE", input); assert.equal(output.output?.message.content, "remote answer"); assert.equal(output.node, "INFER.REASONING.SAMPLE");
    const key = { namespace: "wire", scope: "sample", key: "k" }; await local.invoke("INFER.CACHE.WRITE", { key, value: output.output });
    assert.deepEqual((await local.invoke("INFER.CACHE.LOOKUP", { key })).output?.value, output.output);
    const invalid = await local.invoke("INFER.REASONING.SAMPLE", { ...input, messages: [] }); assert.equal(invalid.error?.code, "INVALID_INPUT");
  } finally {
    await local.close(); await remote.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("invalid successful HTTP JSON is a model output error without echoing its body", async () => {
  const infer = createInfer({ providers: { a: createHttpProvider({ ...options, fetch: async () => new Response("private-response-body") }) } });
  const result = await infer.reasoning.sample(input);
  assert.equal(result.error?.code, "INVALID_MODEL_OUTPUT"); assert.equal(result.error?.message.includes("private-response-body"), false);
});

const toolInput: SampleInput = { ...input, actions: [{ name: "find", inputSchema: { type: "object" } }] };
function sse(events: unknown[]): Response { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")); }
test("Anthropic maps system/tools, cumulative streaming usage and preserves signed assistant blocks", async () => {
  const bodies: Record<string, unknown>[] = [];
  const blocks = [{ type: "thinking", thinking: "private", signature: "signed" }, { type: "text", text: "checking" }, { type: "tool_use", id: "a", name: "find", input: { q: "x" } }];
  const raw = { content: blocks, stop_reason: "tool_use", usage: { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } };
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } }, { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "checking" } }, { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "a", name: "find", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"x"}' } }, { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }, { type: "message_stop" },
  ];
  const provider = createHttpProvider({ ...options, kind: "anthropic", fetch: async (url, init) => {
    assert.equal(url, "https://model.example/v1/messages"); assert.equal(new Headers(init?.headers).get("x-api-key"), "private-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body); return body.stream ? sse(events) : Response.json(raw);
  } });
  const signal = new AbortController().signal;
  const result = await provider.invoke({ ...toolInput, messages: [{ role: "system", content: "system" }, ...input.messages], generation: { maxTokens: 50 } }, { signal });
  const streamed = []; for await (const event of provider.stream!(toolInput, { signal })) streamed.push(event);
  assert.deepEqual(streamed, [{ type: "text_delta", delta: "checking" }, { type: "result", output: result }]);
  assert.equal(result.usage?.totalTokens, 14); assert.equal(bodies[0]?.max_tokens, 50);
  await provider.invoke({ ...toolInput, messages: [...input.messages, result.message, { role: "tool", content: "found", metadata: { actionRequestId: "a" } }] }, { signal });
  const messages = bodies.at(-1)!.messages as { content: unknown[] }[];
  assert.deepEqual(messages[1]?.content, blocks); assert.deepEqual(messages[2]?.content, [{ type: "tool_result", tool_use_id: "a", content: "found" }]);
  await assert.rejects(provider.invoke({ ...input, generation: { seed: 1 } }, { signal }), /does not support/);
});
test("Gemini maps content and function responses, retains thought signatures and merges streaming usage", async () => {
  const bodies: Record<string, unknown>[] = [];
  const parts = [{ text: "checking" }, { functionCall: { id: "g1", name: "find", args: { q: "x" } }, thoughtSignature: "opaque" }];
  const usageMetadata = { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 12, cachedContentTokenCount: 4 };
  const provider = createHttpProvider({ ...options, kind: "gemini", fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "private-key"); const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
    return String(url).endsWith("alt=sse") ? sse([{ candidates: [{ content: { parts: [parts[0]] } }] }, { candidates: [{ content: { parts: [parts[1]] }, finishReason: "STOP" }] }, { usageMetadata }]) : Response.json({ candidates: [{ content: { parts }, finishReason: "STOP" }], usageMetadata });
  } });
  const signal = new AbortController().signal;
  const result = await provider.invoke({ ...toolInput, generation: { maxTokens: 50, seed: 3 }, model: { model: "test-model", providerOptions: { generationConfig: { candidateCount: 9, temperature: 0.7 } } } }, { signal });
  assert.equal(result.usage?.outputTokens, 5); assert.equal(result.actionRequests?.[0]?.id, "g1");
  const streamed = []; for await (const event of provider.stream!(toolInput, { signal })) streamed.push(event);
  assert.deepEqual(streamed, [{ type: "text_delta", delta: "checking" }, { type: "result", output: result }]);
  assert.deepEqual(bodies[0]?.generationConfig, { candidateCount: 1, temperature: 0.7, maxOutputTokens: 50, seed: 3 });
  await provider.invoke({ ...toolInput, messages: [...input.messages, result.message, { role: "tool", content: '{"found":true}', metadata: { name: "find", actionRequestId: "g1" } }] }, { signal });
  const contents = bodies.at(-1)!.contents as { parts: unknown[] }[];
  assert.deepEqual(contents[1]?.parts, parts); assert.deepEqual(contents[2]?.parts, [{ functionResponse: { id: "g1", name: "find", response: { found: true } } }]);
});
test("all provider streams reject truncation and abort blocked body reads", async () => {
  for (const kind of ["openai-compatible", "anthropic", "gemini"] as const) {
    const provider = createHttpProvider({ ...options, kind, fetch: async () => new Response("") });
    await assert.rejects(async () => { for await (const _ of provider.stream!(input, { signal: new AbortController().signal })) { /* Drain. */ } }, /ended before/);
    let cancelled = false;
    const blocked = createHttpProvider({ ...options, kind, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    const controller = new AbortController(); const iterator = blocked.stream!(input, { signal: controller.signal })[Symbol.asyncIterator]();
    const job = iterator.next(); await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await assert.rejects(job, { name: "AbortError" }); assert.ok(cancelled);
  }
});

test("vendor usage never fabricates missing accounting and malformed stream deltas are model errors", async () => {
  for (const kind of ["anthropic", "gemini"] as const) {
    const raw = kind === "anthropic" ? { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: { output_tokens: 2 } }
      : { candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { candidatesTokenCount: 2 } };
    const infer = createInfer({ providers: { fixture: createHttpProvider({ ...options, kind, fetch: async () => Response.json(raw) }) } });
    const result = await infer.reasoning.trajectory({ ...input, strategy: { name: "cot" }, constraints: { maxTotalTokens: 10 } });
    assert.equal(result.error?.code, "USAGE_UNAVAILABLE");
    const events = kind === "anthropic" ? [{ type: "message_start", message: {} }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 42 } }]
      : [{ candidates: [{ content: { parts: [{ text: 42 }] }, finishReason: "STOP" }] }];
    const broken = createHttpProvider({ ...options, kind, fetch: async () => sse(events) });
    await assert.rejects(async () => { for await (const _ of broken.stream!(input, { signal: new AbortController().signal })) { /* Drain. */ } }, { code: "INVALID_MODEL_OUTPUT" });
  }
  const incomplete = createHttpProvider({ ...options, kind: "anthropic", fetch: async () => sse([
    { type: "message_start", message: {} }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "find", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } }, { type: "message_stop" },
  ]) });
  await assert.rejects(async () => { for await (const _ of incomplete.stream!(toolInput, { signal: new AbortController().signal })) { /* Drain. */ } }, { code: "INCOMPLETE_MODEL_OUTPUT" });
});

test("compatible providers can select max_tokens and configure defaults without losing generation limits", async () => {
  let body: Record<string, unknown> = {};
  const provider = createHttpProvider({ ...options, maxTokensField: "max_tokens", providerOptions: { thinking: { type: "disabled" }, max_tokens: 9000 }, fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  } });
  await provider.invoke({ ...input, generation: { maxTokens: 20 } }, { signal: new AbortController().signal });
  assert.equal(body.max_tokens, 20); assert.equal(body.max_completion_tokens, undefined); assert.deepEqual(body.thinking, { type: "disabled" });
});

test("reasoning-enabled compatible tool calls preserve opaque history without emitting it as text", async () => {
  const bodies: Record<string, unknown>[] = [];
  const raw = { choices: [{ message: { content: "", reasoning_content: "opaque fixture", tool_calls: [{ id: "c", type: "function", function: { name: "find", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
  const provider = createHttpProvider({ ...options, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
    return body.stream ? new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:"opaque fixture"}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:"c",type:"function",function:{name:"find",arguments:"{}"}}]},finish_reason:"tool_calls"}]})+'\n\ndata: [DONE]\n\n') : Response.json(raw);
  } });
  const signal = new AbortController().signal;
  const result = await provider.invoke(toolInput, { signal });
  const events = []; for await (const event of provider.stream!(toolInput, { signal })) events.push(event);
  assert.deepEqual(events, [{ type: "result", output: result }]);
  await provider.invoke({ ...toolInput, messages: [...input.messages, { ...result.message, metadata: { ...result.message.metadata, actionRequests: result.actionRequests } }, { role: "tool", content: "found", metadata: { actionRequestId: "c" } }] }, { signal });
  assert.equal((bodies.at(-1)!.messages as Record<string, unknown>[])[1]?.reasoning_content, "opaque fixture");
});
