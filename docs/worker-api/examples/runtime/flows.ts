import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import type { Context, ToolCall } from "@codesoul-co/ditto/contracts";
import type { RuntimeClient } from "@codesoul-co/ditto/worker";
import { createContextWorker, createRagStrategy } from "@codesoul-co/ditto/worker/context";
import { createInteractionWorker, type RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import type { ModelConfig } from "@codesoul-co/ditto/worker/infer";
import {
  createDitto, runMcpFlow, runRagFlow, runReactFlow, runSkillFlow, runToolCallFlow,
  type DittoRuntime,
} from "@codesoul-co/ditto/runtime";

// example: readTextTool
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file", effects: ["read"],
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate(args) { if (typeof args.path !== "string") throw new TypeError("path must be a string"); },
  async execute(args, ctx) {
    return { status: "success", content: await ctx.services.sandbox.readText(args.path as string, ctx.signal) };
  },
};

// example: contextFlows
export async function contextFlows() {
  const runtime = createDitto({
    sandbox: { read: true, tools: ["read_text"] },
    workers: [
      createContextWorker({ services: { ragStrategy: createRagStrategy({ retrieve: {
        async retrieve({ items, query }) {
          if (typeof query !== "string") throw new TypeError("This retriever accepts text queries");
          return items.filter(item => typeof item.content === "string"
            && item.content.toLowerCase().includes(query.toLowerCase())).map(item => ({ item }));
        },
      } }) } }),
      createInteractionWorker({ tools: [readTextTool] }),
    ],
  });
  try {
    const skill = await runSkillFlow(runtime, {
      context: { items: [{ id: "task", content: "Read the project README." }] },
      sources: [{ id: "review-skill", content: "Review correctness and tests." }],
    });
    const selected = await runRagFlow(runtime, { context: skill.context, query: "tests", limit: 1 });
    assert.deepEqual(selected.context.items.map(item => item.id), ["review-skill"]);
    const tool = await runToolCallFlow(runtime, {
      context: selected.context,
      call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
    });
    assert.equal(tool.output.status, "success");
    assert.equal(tool.observation.message.role, "tool");
    assert.equal(tool.context.items.length, 2);
    return { selectedIds: selected.context.items.map(item => item.id), toolStatus: tool.output.status };
  } finally { await runtime.close(); }
}

// example: mcpFlows
export async function mcpFlows(runtime: RuntimeClient, context: Context, server: string, call: ToolCall) {
  // The caller registers CONTEXT and an INTERACTION Worker with a connected MCP client.
  const discovered = await runMcpFlow(runtime, { context, request: { operation: "discover", server } });
  if (!discovered.output.capabilities.some(capability => capability.name === call.name && capability.server === server)) {
    throw new Error(`MCP capability not found: ${server}/${call.name}`);
  }
  const invoked = await runMcpFlow(runtime, {
    context: discovered.context, request: { operation: "invoke", server, call },
  });
  return { capabilities: discovered.output.capabilities, ...invoked };
}

// example: reactFlow
export async function reactFlow(runtime: DittoRuntime, model: ModelConfig) {
  // Register INFER and INTERACTION with readTextTool; configure the model provider and Sandbox.
  const result = await runReactFlow(runtime, {
    model, messages: [{ role: "user", content: "Read README.md and summarize this project." }],
    actions: [{ name: readTextTool.name, description: readTextTool.description!, inputSchema: readTextTool.inputSchema }],
    constraints: { maxSteps: 4, maxActionCalls: 2, maxTotalTokens: 16_000 },
  }, { graphId: "readme-agent", timeoutMs: 30_000 });
  if (result.status !== "completed") throw new Error(`ReAct stopped: ${result.stopReason}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await contextFlows());
}
