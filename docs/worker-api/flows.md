# Predefined flow API

[English / 简体中文](flows.zh-CN.md) · [Runtime](runtime.md) · [API](README.md)

Import these functions from `@ditto/core/runtime`; they compose existing public nodes. Complete code is in [flows.ts](examples/runtime/flows.ts). `npm run example:runtime:flows` executes Skill loading, text RAG and a real README tool read. MCP/ReAct examples require a connected client or model configuration and do not run automatically.

## Context flows

The first four functions take exactly `(runtime: RuntimeClient, input)` and return a Promise. RuntimeClient implements invoke/emit; pass a DittoRuntime or WorkerContext. They use explicit Context and do not persist session caches; use scoped CONTEXT calls when persistence is required.

| API / input | Result and execution |
| --- | --- |
| `runRagFlow(runtime, {context,query?,corpus?,limit?,maxTokens?,options?})` | `{output:ContextSelection,context:output.context}`; SELECT purpose=infer and strategy.kind=rag; requires an injected ragStrategy |
| `runSkillFlow(runtime, {context?,sources})` | `{output:Context,context}`; LOAD sources, then UPDATE when merging an existing context; sources are resolved ContextSource[] |
| `runToolCallFlow(runtime, {context,call})` | `{output:ExternalResult,observation,context}`; TOOL → OBSERVE → UPDATE |
| `runMcpFlow(runtime, {context,request:{operation:"discover",server?}})` | `{output:{operation:"discover",capabilities},context}`; discovery creates no observation and leaves context unchanged |
| `runMcpFlow(runtime, {context,request:{operation:"invoke",server,call}})` | `{output:{operation:"invoke",result},observation,context}`; MCP → OBSERVE → UPDATE; checks callId |

query/content use MessageContent, corpus is a Reference, and options is a JsonObject. limit/maxTokens are optional budgets validated by CONTEXT. call is `{id,name,arguments}`, with JSON-object arguments. Configure tools, MCP clients and their Sandbox permissions on the executing Worker. A business failed result can still become an observation in Context; callers decide whether to continue. Infrastructure exceptions reject.

Skill flows do not download, scan or execute SKILL.md or implicitly check skills permissions. Applications resolve sources and can call sandbox.assert("skills", name) at their resolution/execution boundary. Default CONTEXT.LOAD preserves References without reading their targets; explicit LOAD resolveReferences plus a resolver enables resolution.

Imports and tool definition for the complete example:

```ts
import assert from "node:assert/strict";
import type { Context, ToolCall } from "@ditto/core/contracts";
import type { RuntimeClient } from "@ditto/core/worker";
import { createContextWorker, createRagStrategy } from "@ditto/core/worker/context";
import { createInteractionWorker, type RegisteredTool } from "@ditto/core/worker/interaction";
import type { ModelConfig } from "@ditto/core/worker/infer";
import {
  createDitto, runMcpFlow, runRagFlow, runReactFlow, runSkillFlow, runToolCallFlow,
  type DittoRuntime,
} from "@ditto/core/runtime";
```
```ts
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file", effects: ["read"],
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate(args) { if (typeof args.path !== "string") throw new TypeError("path must be a string"); },
  async execute(args, ctx) {
    return { status: "success", content: await ctx.services.sandbox.readText(args.path as string, ctx.signal) };
  },
};
```

```ts
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
```

This example performs actual substring retrieval over current items. Replace it with a database or RETRIEVAL provider for vector/BM25/hybrid retrieval without changing the flow API. RAG returns selected Context and does not generate an answer. SELECT returns context/selectedItemIds/purpose; map these to messages before INFER as shown in [Context → Infer](context.md).

Both MCP branches:

```ts
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
```

Discovered capabilities describe schemas; they are not ExternalResult and cannot be passed directly to OBSERVE. See [Interaction](interaction.md) for MCP SDK wiring. These flows have no third options argument. Passing ctx from a Worker handler inherits local execution cancellation. For explicit node placement, graph concurrency or signal, compose the same leaves in a graph and use runtime.run(plan,input,options).

## ReAct

`runReactFlow(runtime,input,options?)` accepts a Runtime exposing run/services. Input extends SAMPLE (model/messages/generation/actions/metadata) with constraints; options is `{graphId?,signal?,timeoutMs?}`. Register INFER and Workers for the declared actions; CONTEXT is not required. The model produces ActionRequest values; the flow executes them and feeds Observations into subsequent SAMPLE calls.

```ts
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
```

ReactFlowResult contains result/samples/observations/actionRequests/usage, status (completed/partial/failed), stopReason and optional error, without a NodeResult wrapper. This example throws for non-completion; an application may instead display partial output and retain unresolved actions.

See [ReAct details](../interaction-runtime.md#react-predefined-graph-flow) for constraints, action targets (Tool/MCP/public Node) and stop reasons. Local signals reach model and action handlers; HTTP/IPC cancellation only ends the caller’s wait. Token budgets use Provider usage to limit subsequent sampling, not as a hard billing cap. The flow does not automatically retry external actions.
