/** Explicit integration check; optional SDK/server packages stay outside Ditto's dependencies. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDitto, createInteractionWorker, loadRuntimeConfig } from "@ditto/core";
import { commandExecutor, commandGraph, linuxTool, sha256Tool } from "../examples/interaction-tools.ts";

if (!process.argv[2]) throw new Error("Pass a directory containing the optional MCP SDK and filesystem server dependencies");
const requireSdk = createRequire(join(resolve(process.argv[2]), "package.json"));
const { Client } = requireSdk("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireSdk("@modelcontextprotocol/sdk/client/stdio.js");
const server = join(dirname(requireSdk.resolve("@modelcontextprotocol/server-filesystem/package.json")), "dist/index.js");
const workspace = await realpath(await mkdtemp(join(tmpdir(), "ditto-mcp-live-")));
const file = join(workspace, "with spaces 中文.txt");
const expected = "Ditto command → real MCP filesystem → sha256 tool\n";
const client = new Client({ name: "ditto-live-check", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [server, workspace], stderr: "inherit" });
let runtime;
try {
  await writeFile(file, expected);
  await client.connect(transport);
  const mcp = {
    listTools: (params, options) => client.listTools(params, options),
    async callTool(params, options) {
      const result = await client.callTool(params, undefined, options);
      return { content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    },
  };
  const deliveries = [];
  runtime = createDitto({ config: loadRuntimeConfig({ DITTO_RUNTIME_WORKSPACE: workspace }),
    sandbox: { tools: ["linux", "sha256"], execute: true, mcp: ["files"] }, sandboxExecutor: commandExecutor,
    workers: [createInteractionWorker({ tools: [linuxTool, sha256Tool], mcp: { files: mcp }, output: {
      async deliver(input) { deliveries.push(input); return { deliveryId: input.deliveryId, status: "accepted" }; },
    } })],
  });
  const discovery = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "files" });
  assert.ok(discovery.capabilities.some(tool => tool.name === "read_text_file"));
  const plan = commandGraph
    .node("read", "INTERACTION.ACT.MCP", ["commandObservation"], (input, { commandObservation }) => {
      assert.equal(commandObservation.status, "success");
      return { operation: "invoke", server: "files", call: { id: `${input.id}:read`, name: "read_text_file",
        arguments: { path: commandObservation.structuredContent.stdout },
      } };
    })
    .node("readObservation", "INTERACTION.OBSERVE", ["read"], (_input, { read }) => ({ result: read.result }))
    .node("hash", "INTERACTION.ACT.TOOL", ["readObservation"], (input, { readObservation }) => {
      assert.equal(readObservation.status, "success");
      const content = readObservation.message.content;
      const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("");
      assert.equal(text, expected);
      return { call: { id: `${input.id}:hash`, name: "sha256", arguments: { text } } };
    })
    .node("hashObservation", "INTERACTION.OBSERVE", ["hash"], (_input, { hash }) => ({ result: hash }))
    .node("deliver", "INTERACTION.OUTPUT", ["hashObservation"], (input, { hashObservation }) => ({
      deliveryId: `${input.id}:delivery`, message: { role: "assistant", content: hashObservation.message.content },
    }));
  const result = await runtime.run(plan, { id: "mcp-live", command: "printf", args: ["%s", file] });
  const digest = createHash("sha256").update(expected).digest("hex");
  assert.equal(result.hash.content, digest);
  assert.equal(result.readObservation.callId, "mcp-live:read");
  assert.equal(result.readObservation.source, "files:read_text_file");
  assert.equal(result.deliver.status, "accepted");
  assert.deepEqual(deliveries, [{ deliveryId: "mcp-live:delivery", message: { role: "assistant", content: digest } }]);
  const missing = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "invoke", server: "files",
    call: { id: "missing", name: "read_text_file", arguments: { path: join(workspace, "missing.txt") } },
  });
  assert.equal(missing.result.status, "failed");
  assert.equal(missing.result.error.code, "MCP_TOOL_ERROR");
  console.log(JSON.stringify({ platform: process.platform, transport: "stdio", discovered: discovery.capabilities.length,
    chain: "command → OBSERVE → MCP read → OBSERVE → sha256 → OBSERVE → OUTPUT", sha256: digest,
    delivery: result.deliver.status, missingFile: missing.result.status, status: "passed" }));
} finally {
  await runtime?.close();
  await client.close();
  await transport.close();
  await rm(workspace, { recursive: true, force: true });
}
