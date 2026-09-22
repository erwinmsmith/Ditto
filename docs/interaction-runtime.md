# Providers, Interaction, and Predefined Runtime Flows

**English** | [简体中文](interaction-runtime.zh-CN.md)

This guide describes the current lightweight implementation. The normative Node tree and public input/output contracts are defined in [Node System and API Contract](13-node-api-contract.md).

## Model Providers

Provider adapters live in `src/worker/infer/providers/`. Runtime and INFER share `ModelProvider.invoke/stream` and `ProviderRegistry`, supporting OpenAI-compatible, Anthropic and Gemini protocols. Workers receive ctx.services.providers; the local SDK shares services through createInfer({ runtime }). See the [Provider API](worker-api/providers.md) for construction, environment configuration, tool history and streaming. Vendors/models never create new Node Types.

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
└── index.ts
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
  execute: async (args, context) => ({ status: "success", content: await context.services.sandbox.readText(args.path as string) }),
});
```

`McpRegistry` accepts a structural `McpClient`; the application owns SDK selection, authentication, connection lifecycle, and transport. Core does not depend on an MCP SDK.

The client adapter returns a neutral `McpToolResult` with optional content, structured content, references, `isError`, and a sanitized structured error. MCP discovery defaults to 100 pages and 1000 capabilities in total; applications may configure different positive limits. If `isError` is true and no valid safe error is provided, Core uses the fixed `MCP_TOOL_ERROR` instead of copying untrusted tool content into diagnostics. `createInteractionNodes()` always installs OBSERVE, and installs MCP or OUTPUT only when a registry or an application-owned `OutputSink` is supplied. OUTPUT acceptance is a sink receipt, not proof of final delivery or user reading.

MCP validates requests before accessing the client: operation must be discover/invoke, an explicit server must be nonempty, invoke requires nonempty call.id/name and a JSON object for arguments. Missing arguments, strings, arrays and non-JSON values are rejected instead of being coerced into an empty object. Application adapters still own business-schema validation.

OUTPUT validates deliveryId, message.role/content/name and artifact names/references before calling the sink. Content retains the shared MessageContent JSON semantics, including null, numbers, objects and arrays. Receipts also validate artifacts and metadata; an invalid receipt throws without retrying or implying that delivery did not occur. The same validation applies over HTTP Worker transport.

## Graph, Loop and Worker setup

An application Agent consists of a Graph defining Nodes and data dependencies, a Loop defining iteration state and termination, and Workers supplying implementations and SDK adapters. Use `runtime.run(graph, input)` for one execution or `runtime.loop(loopDefinition, state)` for a loop. No additional Agent manager is required.

The complete [runnable example](../examples/graph-loop-worker.ts) follows Graph → Loop → Worker → Runtime. Run `npm run example:agent` to read README and package.json through TOOL, normalize results with OBSERVE, and print two OUTPUT deliveries. No model or database credentials are needed.

```ts
import { createInteractionWorker } from "@ditto/core/worker/interaction";

// readTextTool, connectedMcpClient and outputSink are application implementations.
const interaction = createInteractionWorker({
  tools: [readTextTool],
  mcp: { files: connectedMcpClient },
  output: outputSink,
  concurrency: 8,
});
// createDitto({ workers: [interaction, infer, memory], sandbox: ... })
```

`createInteractionWorker(options?: InteractionOptions): WorkerDefinition` can be added directly to Runtime's `workers` or passed to `runtime.register()`.

| Option | Type and behavior |
| --- | --- |
| `tools` | `readonly RegisteredTool[]` or `ToolRegistry`; defaults to empty; TOOL and OBSERVE are always exposed |
| `mcp` | Readonly map of server names to `McpClient`, or `McpRegistry`; MCP is not exposed when omitted |
| `output` | `OutputSink`; OUTPUT is not exposed when omitted |
| `concurrency` | Optional positive integer limiting concurrent calls per replica; unlimited by default |

`index.ts` files only export modules. Execution lives in `worker.ts`, `act/tool/node.ts`, `act/tool/registry.ts`, `act/tool/read-only-commands.ts`, `act/tool/web-search.ts`, `act/mcp.ts`, `observe.ts`, and `output.ts`. `createReadOnlyCommandTools()` provides 14 optional registrations: `grep`, `ls`, `cat`, `find`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`, `stat`, `file`, `du`, and `pwd`. They use structured arguments and bounded results and are never registered automatically: the application must inject the returned tools and a `sandboxExecutor`, then grant each tool plus execute permission. Core passes fixed command names and separate arguments without starting a shell; production isolation remains the executor's responsibility.

`createWebSearchTool({ provider })` provides one optional `web_search` registration. It accepts only a bounded query and result limit, requires both `tools:web_search` and the Provider's exact network origin, and returns bounded `title / url / snippet` records plus references. `createBraveWebSearchProvider({ apiKey })` is a thin native-fetch adapter for Brave Web Search. Applications explicitly supply the key and own quota, lifecycle and any retry policy; Core performs no ambient credential lookup or automatic retry.

Arrays and maps are registered once at construction. For dynamic changes, pass registries and use the unregister callback returned by `register()`. Tools still require Sandbox permission. Database adapters belong in MEMORY Workers in the same way: `createMemoryWorker({ store: databaseAdapter })`. Graphs keep calling MEMORY Nodes; search may run in the database itself or explicitly delegate to optional RETRIEVAL.

The application owns connections, authentication, and SDK cleanup. This factory never opens or closes MCP/database connections; reusing one Worker definition shares supplied instances. For separate resources and cleanup per replica, use existing `defineWorker({ resources, dispose, nodes })` with `createInteractionNodes()`. No plugin loader is required. Keep credentials and connection settings in env, and behavior parameters in YAML; tool functions and SDK instances are injected through code, not automatically loaded from arbitrary YAML plugin names.

Run the complete [command and tool composition example](../examples/interaction-tools.ts) with `npm run example:tools`. See the [example guide](../examples/README.md#mcp) for MCP SDK setup and commands.

## Four Predefined Flows

The public functions live directly in `src/runtime/graph.ts` and are exported from `@ditto/core/runtime`. They are reusable Runtime compositions, not Node Types. There is no `src/presets` package.

| Function | Fixed flow |
| --- | --- |
| `runRagFlow()` | `CONTEXT.SELECT` with `strategy: { kind: "rag" }` |
| `runSkillFlow()` | `CONTEXT.LOAD -> CONTEXT.UPDATE` (optional merge) |
| `runToolCallFlow()` | `INTERACTION.ACT.TOOL -> INTERACTION.OBSERVE -> CONTEXT.UPDATE` |
| `runMcpFlow()` | `discover`: MCP only; `invoke`: MCP -> OBSERVE -> CONTEXT.UPDATE |

Injected createRagStrategy manages optional embed/rank and required retrieve. Tool/MCP calls return Observation and update explicit Context through ContextIngress; discovery does not update it.

```ts
import { runSkillFlow, runToolCallFlow } from "@ditto/core/runtime";

const skill = await runSkillFlow(runtime, {
  context,
  sources: [{ id: "code-review", content: "Review correctness and tests." }],
});

const tool = await runToolCallFlow(runtime, {
  context: skill.context,
  call: { id: "call-1", name: "read_text", arguments: { path: "README.md" } },
});
```

Applications may compose the same leaf Nodes differently with `ExecutionGraph`; the four functions only standardize the commonly reused ingress paths.

## Skill Lifecycle

Applications resolve Skill content and pass sources to runSkillFlow, which invokes LOAD and optionally UPDATE.


## Sandbox and Deployment

File, command, tool, MCP, Skill, and network access remain deny-by-default. The Sandbox is a cooperative permission service; untrusted implementations must run in an OS process or container with appropriate isolation.

Graph definitions and Node Contracts do not contain provider keys, host addresses, or Worker IDs. Runtime routing therefore allows the same Graph to move from local execution to remote Workers without changing its semantic Node calls.

## ReAct predefined graph flow

ReAct lives in src/runtime/react.ts as a predefined Graph execution flow: SAMPLE → declared actions → observation feedback → next SAMPLE. It is neither an INFER Node nor a TRAJECTORY strategy. Runtime owns loop state, budgets and cross-Worker scheduling; SAMPLE owns model computation.

```ts
import { runReactFlow, createInferWorker, defineWorker, observeExternalResult } from "@ditto/core";
runtime.register(createInferWorker());
runtime.register(defineWorker({ type: "INTERACTION", nodes: {
  "INTERACTION.ACT.TOOL": async ({ call }) => ({
    callId: call.id, source: `tool:${call.name}`, status: "success", content: { found: true },
  }),
  "INTERACTION.OBSERVE": async ({ result }) => observeExternalResult({ result }),
} }));
const result = await runReactFlow(runtime, {
  model: { provider: "primary", model: "your-model-id" },
  messages: [{ role: "user", content: "Search and answer." }],
  actions: [{ name: "search", inputSchema: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"],
  } }],
  constraints: { maxSteps: 8, maxActionCalls: 4, maxTotalTokens: 16_000 },
}, { graphId: "search-agent", timeoutMs: 20_000 });
console.log(result.status, result.result, result.observations);
```

```ts
runReactFlow(
  runtime: Pick<DittoRuntime, "run" | "services">,
  input: ReactFlowInput,
  options?: { graphId?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<ReactFlowResult>;
```

```ts
export interface ReactFlowInput extends SampleInput {
  constraints?: { maxSteps?: number; maxActionCalls?: number; maxTotalTokens?: number; timeoutMs?: number };
}
export interface ReactFlowResult {
  result: Message;
  samples: SampleOutput[];
  observations: Observation[];
  actionRequests: ActionRequest[];
  status: "completed" | "partial" | "failed";
  stopReason: "completed" | "max_steps" | "max_action_calls" | "max_tokens" | "timeout" | "cancelled" | "dependency_failed" | "error";
  usage: Usage;
  error?: { code: string; message: string };
}
```

ReactFlowInput inherits SAMPLE model/messages/generation/actions/metadata. Upstream Graphs fetch Context/Memory or plans and assemble messages. Invalid input throws; execution errors return ReactFlowResult without an INFER NodeResult wrapper.

| Option | Default and behavior |
| --- | --- |
| graphId | react; SAMPLE/actions go through runtime.run with Graph execution scopes; each run has its own runId |
| maxSteps | Runtime config.maxTurns (default 8); positive maximum SAMPLE count |
| maxActionCalls | Runtime config.react.maxActionCalls, fallback 16, nonnegative; zero preserves requests without executing actions |
| maxTotalTokens | Runtime config.react.maxTotalTokens, otherwise unlimited; accumulated usage limits subsequent sampling, not a hard per-request billing cap |
| timeoutMs | Minimum of constraints and options/Runtime config.timeoutMs; library fallback 30 seconds, root YAML 120 seconds |
| signal | Stops waiting/scheduling; already dispatched remote work may continue |

Caller-owned `ActionDescriptor.target` selects a direct tool, an MCP server/tool pair, or a public Node. Missing targets default to direct TOOL. Runtime fixes MCP operation to `invoke`; model arguments cannot select a server or route. TOOL/MCP results pass through OBSERVE before SAMPLE feedback. Actions execute sequentially. A structured `failed` result reaches the next SAMPLE; `cancelled`, `timeout`, and `unknown` stop new actions. Infrastructure exceptions stop the flow without inventing an observation. Core never automatically retries an operation that may affect an external system.

Completion returns completed. Budget/timeout/error stops return partial when a SAMPLE exists, otherwise failed. actionRequests contains unresolved requests. A timed-out action remains pending because its outcome is unknown; this does not mean the action had no external impact. Successful observations feed the next tool message, preserving vendor metadata. No new actions start if the model step budget cannot consume their observations.

Missing usage produces USAGE_UNAVAILABLE. Duplicate action IDs, undeclared actions and invalid model outputs stop the flow. Runtime has no cross-Worker cancellation protocol; deadlines stop local waiting and scheduling only. Planning belongs in an upstream SAMPLE Graph step, with its plan supplied to this flow; there is no duplicate plan-and-act strategy.

Shared generation and budget defaults: [configuration API](worker-api/configuration.md).

Use MEMORY.SEARCH for durable recall; the Graph checks NodeResult and maps results to CONTEXT.UPDATE. See [MEMORY API](worker-api/memory.md).
