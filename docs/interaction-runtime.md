# Providers, Interaction, and Predefined Runtime Flows

**English** | [简体中文](interaction-runtime.zh-CN.md)

This guide describes the current lightweight implementation. The normative Node tree and public input/output contracts are defined in [Node System and API Contract](13-node-api-contract.md).

## Model Providers

Provider adapters stay in the flat `src/worker/infer/providers/` directory. `PROVIDERS` is an implementation boundary under `INFER`, not a routable Node and not a vendor taxonomy. Do not add vendor-specific folders until independent implementations require them.

`ProviderRegistry` resolves a provider by name. Every adapter implements the fixed `ModelProvider.invoke(ProviderRequest): Promise<ModelOutput>` boundary. Provider choice, credentials, model IDs, deployment location, and replica count do not create new Node Types.

```ts
import { ProviderRegistry } from "@ditto/core/worker/infer/providers";

const providers = new ProviderRegistry();
providers.register("custom", {
  invoke: async (request) => ({
    message: { role: "assistant", content: `handled ${request.input.messages.length} messages` },
  }),
});
```

The built-in HTTP adapters are optional conveniences. Custom SDK adapters may be registered through the same interface. Core does not maintain a model catalog, select vendors automatically, or turn a vendor into a Node.

## Interaction Boundary

`INTERACTION` contains only external-world semantics:

- `INTERACTION.ACT.TOOL` invokes a directly registered/native tool.
- `INTERACTION.ACT.MCP` discovers or invokes a capability through MCP.
- `INTERACTION.OBSERVE` normalizes returned environment information.
- `INTERACTION.OUTPUT` submits the final task result.

There is no `INTERACTION.COMMUNICATE`. Application input is supplied at the application/Runtime boundary. Worker-to-Worker `invoke` and `emit` are Runtime communication primitives, not Interaction Nodes.

`INTERACTION.ACT.TOOL` remains one routable Node, while its implementation is a directory:

```text
src/worker/interaction/act/tool/
├── node.ts
├── registry.ts
├── index.ts
└── linux-commands/     # registered tool implementations, not Node Types
```

```ts
import { ToolRegistry } from "@ditto/core/worker/interaction";

const tools = new ToolRegistry();
tools.register({
  name: "read_text",
  description: "Read a workspace text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate: (args) => {
    if (typeof args.path !== "string") throw new Error("path must be a string");
  },
  execute: async (args, context) => context.services.sandbox.readText(args.path as string),
});
```

`McpRegistry` accepts a structural `McpClient`; the application owns SDK selection, authentication, connection lifecycle, and transport. Core does not depend on an MCP SDK.

## Four Predefined Flows

The public functions live directly in `src/runtime/graph.ts` and are exported from `@ditto/core/runtime`. They are reusable Runtime compositions, not Node Types. There is no `src/presets` package.

| Function | Fixed flow |
| --- | --- |
| `runRagFlow({ scope: "context" })` | `CONTEXT.RAG.RETRIEVE -> CONTEXT.RAG.RANK -> CONTEXT.UPDATE` |
| `runRagFlow({ scope: "memory" })` | `MEMORY.RAG.RETRIEVE -> MEMORY.RAG.RANK -> CONTEXT.UPDATE` |
| `runSkillFlow()` | `MEMORY.SKILL -> CONTEXT.UPDATE` |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL -> CONTEXT.UPDATE` |
| `runMcpFlow()` | `INTERACTION.ACT.MCP -> CONTEXT.UPDATE` |

RAG `EMBED` is deliberately excluded from the query-time flow because it prepares representations/indexes. Every function receives a Runtime client and the current `Context`, then returns both its source result and the updated Context. Source-specific data enters `CONTEXT.UPDATE` through the shared `ContextIngress` boundary.

```ts
import { runSkillFlow, runToolCallFlow } from "@ditto/core/runtime";

const skill = await runSkillFlow(runtime, {
  context,
  name: "code-review",
});

const tool = await runToolCallFlow(runtime, {
  context: skill.context,
  call: { id: "call-1", name: "read_text", arguments: { path: "README.md" } },
});
```

Applications may compose the same leaf Nodes differently with `ExecutionGraph`; the four functions only standardize the commonly reused ingress paths.

## Skill Lifecycle

`MEMORY.SKILL` stores/retrieves durable procedural knowledge. `CONTEXT.SKILL` represents a Skill activated in the current working set. The predefined Skill flow retrieves `MEMORY.SKILL` and writes its instructions through `CONTEXT.UPDATE`; it does not invent another Skill Node.

`SkillRegistry` is the lightweight process-local reference implementation. Durable stores can implement the same Node Contract independently.

## Sandbox and Deployment

File, command, tool, MCP, Skill, and network access remain deny-by-default. The Sandbox is a cooperative permission service; untrusted implementations must run in an OS process or container with appropriate isolation.

Graph definitions and Node Contracts do not contain provider keys, host addresses, or Worker IDs. Runtime routing therefore allows the same Graph to move from local execution to remote Workers without changing its semantic Node calls.
