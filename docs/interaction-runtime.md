# Agents, Providers, and the Runtime Environment

**English** · [简体中文](interaction-runtime.zh-CN.md)

Graph execution and bounded repetition live in `src/runtime/graph.ts` and `src/runtime/loop.ts`. Tools, MCP, and Skills live in `src/worker/interaction/`; current model generation and adapters live in `src/worker/reasoning/`. The target Provider location is `src/worker/infer/providers/`. An Agent is application state + Graph + Loop. Applications establish external connections and choose deployment policies.

> `INTERACTION.RUN` has been removed in favor of `runtime.loop()`. Other names still use current runnable Contracts: under the [target Contract](13-node-api-contract.md), model calls move to `INFER.REASONING.*`, tools/MCP to `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`, and Skills to `MEMORY.SKILL` / `CONTEXT.SKILL`. Those remaining migrations are not yet implemented.

## Configuration Precedence and Environment Files

1. Applications load environment variables using Node's `--env-file=.env`, or `--env-file-if-exists` for an optional file.
2. `loadRuntimeConfig()` explicitly parses and validates the environment, then supplies `createDitto({ config })`.
3. A Worker's `createGenerateNode({ model })` overrides the Runtime's default model. When omitted, it uses `config.model`.
4. A complete policy passed to `createDitto({ sandbox })` replaces the sandbox policy in the configuration. Unlisted permissions remain denied.

Importing the library or calling createDitto without config does not read `.env` or credentials from environment variables. Configuration includes the environment label, workspace, default Provider/model, Provider settings, request timeout, Agent turn limit, and permissions. `environment` is a label; it does not start a container or switch security levels automatically.

See [.env.example](../.env.example) for all variables. `.env` / `.env.*` are ignored; only the example file should be committed. Keys stay in the execution host's configuration or adapter closures, not in Graphs or configuration fields of invocation Envelopes. Applications should not log the full config.

Example configuration for a real model; replace the model name with an ID available to your account:

```dotenv
DITTO_PROVIDERS=primary,claude
DITTO_MODEL_PROVIDER=primary
DITTO_MODEL=your-model-id
DITTO_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_PROVIDER_PRIMARY_BASE_URL=https://api.openai.com/v1
DITTO_PROVIDER_PRIMARY_API_KEY=replace-locally
DITTO_PROVIDER_CLAUDE_KIND=anthropic
DITTO_PROVIDER_CLAUDE_BASE_URL=https://api.anthropic.com/v1
DITTO_PROVIDER_CLAUDE_API_KEY=replace-locally
DITTO_ALLOW_NETWORK=https://api.openai.com,https://api.anthropic.com
DITTO_ALLOW_TOOLS=echo
DITTO_ALLOW_SKILLS=concise
```

The echo/concise names above illustrate allowlist syntax. Applications must register the corresponding tools and Skills; environment variables do not create capabilities. `examples/` is currently empty.

## Multiple Providers

Current `ModelProvider.generate(ModelRequest)` returns normalized text and toolCalls. The target Contract renames this boundary to `ModelProvider.invoke(ProviderRequest): Promise<ModelOutput>` so it is not confused with a GENERATE Node. `ProviderRegistry` registers implementations by name. By default, HTTP providers are assembled from config. If an application explicitly injects a `providers` registry, it owns the complete registration set; providers from config are not added automatically.

Built-in adapters support text and function-tool requests/results for OpenAI-compatible Chat Completions and Anthropic Messages. They translate OpenAI's tool_calls/tool_call_id and Anthropic's tool_use/tool_result internally. Model names come from configuration. The library does not hardcode a model catalog, switch Providers automatically, retry requests, or make billable calls to discover capabilities.

```ts
import { defineWorker, createGenerateNode } from "@ditto/core";

const worker = defineWorker({
  type: "reviewer", expose: ["REASONING.GENERATE"],
  nodes: { "REASONING.GENERATE": createGenerateNode({ model: { provider: "claude", model: "your-model-id" } }) },
});
```

Custom SDKs, other vendors, streaming, or multimodal models can implement and register `ModelProvider`. Built-in adapters currently do not support streaming, images, vendor reasoning blocks, or arbitrary vendor parameter passthrough. Unsupported response blocks cause failure rather than silently losing information. Custom Providers must enforce network permissions and honor the supplied AbortSignal themselves; Core cannot intercept arbitrary direct I/O inside an adapter.

Protocol references: [OpenAI Chat API](https://developers.openai.com/api/reference/cli/resources/chat), [Anthropic tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).

## Graph, Loop, and Leaf Nodes

| Node | Input and behavior |
| --- | --- |
| `REASONING.GENERATE` | Calls the selected Provider with only the tool schemas allowed by current permissions |
| `INTERACTION.TOOL` | Checks permissions, validates arguments, and executes a local or MCP tool |
| `INTERACTION.TOOL_BATCH` | Accepts `{ calls }`, checks unique/nonempty IDs and available names, executes sequentially, and returns `{ id, result }[]`; an empty batch returns `[]` |
| `INTERACTION.SKILL` | Retrieves registered and permitted Skill instructions by name |

These contracts extend NodeContractMap without changing v1.0 Message or REASONING.INFER. `ModelMessage` separately represents tool call IDs and result correlation, keeping Provider protocol fields out of the original Message type.

`createInteractionNodes({ tools, skills })` returns three interaction handlers. Compose model generation separately with `createGenerateNode({ model, tools: (ctx) => tools.list(ctx) })`. Both factories preserve custom Worker resource/config types. Expose the capabilities used by the application Graph; `ctx.run` still supports private composition inside a replica.

Define one round with a DAG, then use `loop({ graph, bind, update, done, maxIterations })` and `runtime.loop(definition, initialState)`. `graph` accepts a fixed DAG or `(state) => graph`, allowing a different DAG on every step. Each round selects its Graph, binds input, awaits execution, calls `update`, then calls `done` with the updated state and output. All callbacks are synchronous; the Loop returns final state, defaults to 32 iterations, and throws when the limit is exhausted. Errors propagate without retries. Definitions can be reused, but applications own state and should return new values rather than mutate shared objects. See the [complete README compositions](../README.md#run-multiple-rounds).

Tool batches check IDs and currently available names before any tool effects; each tool's required validate callback checks its arguments before that tool executes. A failure stops subsequent calls without rolling back earlier effects. MCP's isError is preserved as a result. Keep the generation tool catalog and execution permissions aligned, including across hosts; each execution host enforces its own policy. Batch execution has no model loop or conversation state.

The generic Loop does not know which Nodes perform effects. The README's application Graph rejects tool requests on the final model turn before calling the batch Node. `config.maxTurns` / `DITTO_MAX_TURNS` is an application setting passed explicitly as `maxIterations`; it does not override the generic Loop default. `timeoutMs` limits each built-in Provider request, not the entire Loop/tool/MCP session. Tools need their own I/O deadlines. Await top-level Loops before closing the Runtime; the Loop provides no checkpointing, rollback, or cancellation.

Migration from the old factory: remove `INTERACTION.RUN` from `expose` and invocation sites, move `model` to `createGenerateNode`, move `maxTurns` to the Loop definition, and place messages/Skill instructions in application state. `InteractionRunInput` and `InteractionRunOutput` are no longer exported.

## Tools and MCP

Register local tools with ToolRegistry.register, supplying name, description, inputSchema, validate, and execute. The schema describes arguments to the model; validate performs the actual pre-execution check. Core does not include a JSON Schema engine. Applications requiring full JSON Schema validation can call their chosen validator from validate.

```ts
const tools = new ToolRegistry();
tools.register({
  name: "read_text", description: "Read a workspace file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  validate: (args) => { if (typeof args.path !== "string") throw new Error("path must be string"); },
  execute: async (args, ctx) => ctx.services.sandbox.readText(args.path as string),
});
```

Applications use an official MCP SDK to connect to stdio or Streamable HTTP services and adapt the connection to McpClient. Core does not launch arbitrary MCP processes or implement another JSON-RPC protocol stack.

```ts
// client is an MCP SDK client connected by the application with authentication and timeouts.
const remove = await registerMcpTools(tools, "files", client, runtime.services.sandbox);
// Paginated tools/list results are registered as files__<tool-name>; tools/call results are preserved.
// When finished: remove(); await client.close(); (the application owns the connection)
```

The MCP server allowlist is checked before registration and again at invocation. Calls also require the full tool name in the tools allowlist. The MCP server validates arguments against its schema; the local layer checks object shape and permissions. Repeated pagination cursors or registration conflicts roll back that registration attempt. The returned remove function unregisters its tools. Names must use `[a-zA-Z0-9_-]` and be at most 64 characters to fit the common Provider naming rules; invalid names fail explicitly. Applications refresh registration when tool lists change.

MCP network and process permissions are enforced by the connecting SDK and deployment sandbox. Allowing a server name does not grant a remote service access to the client's filesystem. Protocol reference: [MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## Skill Management

SkillRegistry supports register/list/get and `load(name, path, sandbox)` to read a workspace SKILL.md. Callers provide the name explicitly, and the entire file is stored as instructions. It does not implicitly parse YAML, scan the filesystem, execute scripts, or download dependencies.

Loading requires read permission and the corresponding skills permission. Accessing registered content checks skills permission again. register returns an unregister function. Applications invoke `INTERACTION.SKILL` explicitly and put the returned instructions into initial Loop messages or a Graph binding. Skill text cannot expand tool/network/execution permissions and does not automatically run referenced files.

## Sandbox Boundaries

File reads/writes, external commands, and tools/mcp/skills/network are denied by default. Allowlists match exact names; network entries match URL origins, and `*` explicitly allows all. Built-in Providers check the origin before making requests and reject HTTP redirects. Worker transport is the application's deployment control plane and uses separately configured addresses and credentials.

Sandbox.readText/writeText confine paths to the workspace, resolve existing symlinks, and reject writes to outside or dangling targets. They do not create directories recursively. `run` executes only when execute=true and the application supplies a SandboxExecutor; it never falls back to a host shell.

This is a cooperative permission service. It cannot isolate arbitrary JavaScript in an in-process Node/Tool, prevent direct fs/fetch calls that bypass the service, or eliminate every race involving concurrent path replacement by an attacker. Deploy untrusted plugins/commands in separate processes controlled by the OS or a container, with restricted mounts, network, environment, resources, and timeouts. The SandboxExecutor implementation owns those isolation guarantees. Host environment variables and model keys are not forwarded to commands by default.
