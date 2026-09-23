# INTERACTION Worker API

**English** · [简体中文](interaction.zh-CN.md) · [Worker API](README.md)

INTERACTION executes external actions, normalizes observations, and delivers final messages. Graph defines dependencies; Loop owns iteration and termination; Worker injects tools, MCP clients, and output sinks. No separate Agent manager, automatic command registration, or plugin scanner is needed.

## 1. Imports and API inventory

```ts
import { createBraveWebSearchProvider, createInteractionWorker, createReadOnlyCommandTools, createWebSearchTool, ToolRegistry, McpRegistry } from "@ditto/core/worker/interaction";
// Also exported by @ditto/core.
```

| API | Return / purpose |
| --- | --- |
| `createInteractionWorker(options?)` | WorkerDefinition; standard setup |
| `createInteractionNodes(options?)` | WorkerNodes for custom defineWorker |
| `ToolRegistry.register / list / call` | Register/remove, list permitted tools, invoke one tool |
| `createReadOnlyCommandTools(options?)` | 14 optional read-only command registrations with structured inputs and bounded output |
| `createWebSearchTool({ provider })` | Optional provider-neutral `web_search` registration with bounded normalized results |
| `createBraveWebSearchProvider(options)` | Native-fetch Brave Web Search adapter; application supplies credentials |
| `McpRegistry.register / execute` | Register/remove clients, discover or invoke MCP tools |
| `createToolHandler / createMcpHandler / createOutputHandler` | Construct individual leaf NodeHandlers |
| `observeExternalResult(input)` | Synchronously returns Observation; pure normalization |
| `RegisteredTool.validate / execute` | Application tool port; execute returns ToolExecutionOutcome |
| `McpClient.listTools / callTool` | Application-owned SDK client port |
| `OutputSink.deliver` | Promise<OutputReceipt>; delivery port |

| Node | Input | Output |
| --- | --- | --- |
| INTERACTION.ACT.TOOL | `{ call: ToolCall }` | `ExternalResult` |
| INTERACTION.ACT.MCP | discover / invoke union | discover / invoke union |
| INTERACTION.OBSERVE | `{ result: ExternalResult }` | `Observation` |
| INTERACTION.OUTPUT | `{ deliveryId, message, artifacts? }` | `OutputReceipt` |

These Nodes return the listed Output directly, **without NodeResult**, executionId, or an output wrapper. Actions correlate through callId; delivery through deliveryId. Registration/validation errors, permission denial, and unclassified SDK errors reject the Promise; business failures use structured results.

## 2. Complete examples and setup

Examples share the imports from [examples/interaction.ts](examples/interaction.ts). The complete file is checked by `npm run typecheck`; importing executes no examples. Connect SDK resources in your application before injecting them.

```ts
import { createDitto, defineWorker, graph, loop, type WorkerContext } from "@ditto/core";
import {
  createInteractionWorker, createInteractionNodes, createToolHandler, createMcpHandler,
  createOutputHandler, observeExternalResult, ToolRegistry, McpRegistry,
  interactionObserveNode, type RegisteredTool, type McpClient, type OutputSink,
} from "@ditto/core/worker/interaction";
```

### RegisteredTool.validate / execute

Schema describes the capability; Core installs no JSON Schema validator. validate must enforce the actual business input contract. execute performs one action, without owning an Agent loop.

| Field | Requirement and behavior |
| --- | --- |
| `name` | Required; 1–64 letters, digits, underscores, or hyphens; unique per registry |
| `description?` | Capability description |
| `inputSchema` | Required JsonObject; provided to callers/models, not automatically enforced |
| `effects?` | Array of read / write / execute / network descriptors |
| `requiresApproval?` | Descriptive flag; Core does not open approval UI or change Sandbox permissions |
| `validate(args)` | Synchronous validation; a thrown error prevents execute |
| `execute(args, context)` | Returns `Promise<Omit<ExternalResult, "callId" \| "source">>` |

```ts
export const readTextTool: RegisteredTool = {
  name: "read_text", description: "Read a workspace text file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  effects: ["read"], requiresApproval: false,
  validate(args) {
    if (!args || typeof args.path !== "string" || !args.path.trim()) throw new Error("path must be a nonempty string");
  },
  async execute(args, context) {
    return { status: "success", content: await context.services.sandbox.readText(args.path as string) };
  },
};
```

context provides services.sandbox/config/providers, Worker/execution identity, invoke/emit, and internal Graph execution. Use Sandbox for file, command, and network access; it is a cooperative guard, not isolation against arbitrary application JS.

### createReadOnlyCommandTools(options?)

This helper returns 14 ordinary RegisteredTool values; it does not register them or create a process executor. Inputs expose only common read operations rather than arbitrary flags:

| Tool | Structured arguments | Fixed command shape |
| --- | --- | --- |
| `grep` | `pattern`, `paths`, optional `recursive`, `ignoreCase`, `fixedStrings` | `grep -n ... -- pattern paths...` |
| `ls` | optional `path`, `all` | `ls -1 [-a] -- path` |
| `cat` | `path` | `cat -- path` |
| `find` | optional `path`, `name`, `type`, `maxDepth` | `find path -maxdepth ... [-type ...] [-name ...] -print` |
| `head` / `tail` | `path`, optional `lines` (1–1,000; default 20) | `head/tail -n lines -- path` |
| `wc` | `path`, optional `metric` (`lines / words / bytes`) | `wc -l/-w/-c -- path` |
| `sort` | `path`, optional `reverse`, `numeric`, `unique` | `sort [-r] [-n] [-u] -- path` |
| `uniq` | `path`, optional `count`, `ignoreCase` | `uniq [-c] [-i] -- path` |
| `cut` | `path`, `fields`, optional one-character `delimiter` | `cut [-d delimiter] -f fields -- path` |
| `stat` / `file` | `path` | `stat/file -- path` |
| `du` | `path`, optional `maxDepth` (0–32; default 1) | `du -k --max-depth=N -- path` |
| `pwd` | no fields | `pwd` |

Paths must be relative POSIX workspace paths; absolute paths, backslashes, traversal segments, unknown fields, and raw find expressions are rejected before execution. Defaults are 1,000 returned lines, 64 KiB stdout, and 8 KiB stderr. Options may lower or raise them only within hard caps of 10,000 lines, 1 MiB stdout, and 64 KiB stderr. Output truncation is UTF-8 safe and reported in `structuredContent.truncated`.

```ts
const commandTools = createReadOnlyCommandTools({ maxEntries: 200, maxOutputBytes: 32 * 1024 });
const runtime = createDitto({
  sandbox: { tools: commandTools.map(tool => tool.name), execute: true },
  sandboxExecutor,
  workers: [createInteractionWorker({ tools: commandTools })],
});
```

Each invocation calls `sandbox.run({ command, args })` once. A nonzero exit becomes a `failed` ExternalResult with `COMMAND_EXIT_NONZERO`; startup, permission, transport, or executor exceptions still reject and are never retried automatically. Relative-path validation is a cooperative API boundary, not protection against a malicious executor or workspace symlink; use OS/container isolation for untrusted workloads.

### createWebSearchTool({ provider })

`web_search` accepts `{ query, limit? }`; query is a nonempty single line of at most 600 characters and 75 words, and limit defaults to 5 with a hard maximum of 20. The Tool normalizes at most the requested results to `title / url / snippet`, bounds titles to 256 characters and snippets to 2,048 characters, accepts only HTTP(S) URLs without embedded credentials, and emits each URL as a Reference.

```ts
const provider = createBraveWebSearchProvider({ apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY! });
const webSearch = createWebSearchTool({ provider });
const runtime = createDitto({
  sandbox: { tools: [webSearch.name], network: [provider.origin] },
  workers: [createInteractionWorker({ tools: [webSearch] })],
});
```

The registry checks Tool permission before validation; the Tool checks the exact Provider origin before calling it. Provider errors and malformed results become one sanitized `failed / WEB_SEARCH_FAILED` result without retry. Credentials, quotas and retry/lifecycle policies remain application responsibilities and never enter the ToolCall. The Brave adapter uses `GET /res/v1/web/search`, `X-Subscription-Token`, native fetch and a configurable timeout; it is not registered automatically.

### OutputSink.deliver

Return a receipt with the same deliveryId. This sink prints JSON; applications can supply UI, HTTP, or queue delivery with their own lifecycle and retry policy.

```ts
export const consoleSink: OutputSink = {
  async deliver(input) {
    console.log(JSON.stringify({ id: input.deliveryId, message: input.message, artifacts: input.artifacts }));
    return { deliveryId: input.deliveryId, status: "accepted", ...(input.artifacts ? { artifacts: input.artifacts } : {}) };
  },
};
```

### createInteractionWorker(options?)

| Option | Type / default behavior |
| --- | --- |
| `tools?` | readonly RegisteredTool[] or ToolRegistry; empty by default, TOOL remains exposed |
| `mcp?` | Readonly<Record<string, McpClient>> or McpRegistry; omission leaves MCP unexposed |
| `output?` | OutputSink; omission leaves OUTPUT unexposed |
| `concurrency?` | Positive integer limiting concurrent calls per replica; unlimited by default |

OBSERVE is always exposed. Arrays/maps are registered at construction; supplied registries retain identity for dynamic updates. The factory grants no tool or network permissions.

```ts
export function setupInteraction(client: McpClient) {
  return createDitto({
    sandbox: { tools: ["read_text"], read: true, mcp: ["files"] },
    workers: [createInteractionWorker({ tools: [readTextTool], mcp: { files: client }, output: consoleSink, concurrency: 8 })],
  }); // client is already connected; the application closes it after runtime.close().
}
```

## 3. ACT.TOOL and tool registry

```ts
interface ToolCall { id: string; name: string; arguments: JsonObject; }
interface InteractionToolInput { call: ToolCall; }
type InteractionToolOutput = ExternalResult;
```

call.id is nonempty; name selects a registered tool. arguments is a JSON object whose business shape is checked by validate. Execution checks ID, tools permission, registration, and arguments before execute, then validates the result. Core supplies callId=call.id and source=call.name.
```ts
export async function invokeTool() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool] })] });
  try {
    const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } } });
    if (result.status !== "success") throw new Error(result.error?.code ?? result.status);
    return result.content; // Direct ExternalResult; no .output wrapper.
  } finally { await runtime.close(); }
}
```

### ToolRegistry.register / list / call

new ToolRegistry() starts empty. register(tool) returns an unregister callback: true once, false afterwards. Invalid/duplicate names throw immediately. list(context) returns permitted definitions without executable functions. call(call, context) returns Promise<ExternalResult>. Use a genuine Worker context.
```ts
export async function toolRegistryApis(context: WorkerContext<unknown, unknown>) {
  const tools = new ToolRegistry();
  const unregister = tools.register(readTextTool);
  const definitions = tools.list(context); // Only tools allowed by context.services.sandbox.
  try {
    const result = await tools.call({ id: "read-1", name: "read_text", arguments: { path: "README.md" } }, context);
    return { definitions, result };
  } finally { unregister(); } // true on first removal, false afterwards; does not close tool resources.
}
```

## 4. ACT.MCP and client adapters

```ts
type InteractionMcpInput =
  | { operation: "discover"; server?: string }
  | { operation: "invoke"; server: string; call: ToolCall };
type InteractionMcpOutput =
  | { operation: "discover"; capabilities: readonly McpCapability[] }
  | { operation: "invoke"; result: ExternalResult };
interface McpClient {
  listTools(params?: { cursor?: string }, options?: McpCallOptions): Promise<{
    tools: readonly { name: string; description?: string; inputSchema: JsonObject; outputSchema?: JsonObject }[];
    nextCursor?: string;
  }>;
  callTool(params: { name: string; arguments: JsonObject }, options?: McpCallOptions): Promise<McpToolResult>;
}
interface McpToolResult {
  content?: MessageContent; structuredContent?: JsonValue;
  references?: readonly Reference[]; isError?: boolean; error?: InteractionError;
}
```

discover invokes no tools, produces no Observation, and changes no Context. Omitting server visits all registered servers; every access requires mcp permission and denied servers are not silently filtered. Capabilities contain server, name, inputSchema, and optional description/outputSchema. invoke uses the application-selected server/tool and preserves callId; source is `server:toolName`.
```ts
export async function invokeMcp(client: McpClient, absoluteFilePath: string) {
  const runtime = setupInteraction(client);
  try {
    const discovery = await runtime.invoke("INTERACTION.ACT.MCP", { operation: "discover", server: "files" });
    if (discovery.operation !== "discover") throw new Error("Expected discovery response");
    const response = await runtime.invoke("INTERACTION.ACT.MCP", {
      operation: "invoke", server: "files", call: { id: "mcp-read", name: "read_text_file", arguments: { path: absoluteFilePath } },
    });
    if (response.operation !== "invoke") throw new Error("Expected invocation response");
    return { capabilities: discovery.capabilities, result: response.result };
  } finally { await runtime.close(); }
}
```

### McpRegistry.register / execute

new McpRegistry({ maxDiscoveryPages?, maxCapabilities? }) defaults to 100 pages and 1000 capabilities per discovery request; limits are positive integers. Repeated cursors, exceeded limits, or invalid schemas fail. register(server, client) requires a nonempty unique name and returns an unregister callback. execute(input, sandbox) handles discovery and invocation; removal does not close clients.
```ts
export async function mcpRegistryApis(client: McpClient, absoluteFilePath: string) {
  const runtime = createDitto({ sandbox: { mcp: ["files"] } });
  const mcp = new McpRegistry({ maxDiscoveryPages: 10, maxCapabilities: 200 });
  const unregister = mcp.register("files", client);
  try {
    const discovery = await mcp.execute({ operation: "discover", server: "files" }, runtime.services.sandbox);
    const result = await mcp.execute({ operation: "invoke", server: "files", call: { id: "mcp-1", name: "read_text_file", arguments: { path: absoluteFilePath } } }, runtime.services.sandbox);
    return { discovery, result };
  } finally { unregister(); await runtime.close(); }
}
```

### McpClient.listTools / callTool adapter example

```ts
export function mcpClientAdapter(client: McpClient): McpClient {
  return {
    listTools: (params, options) => client.listTools(params, options),
    async callTool(params, options) {
      const result = await client.callTool(params, options);
      return {
        ...(result.content === undefined ? {} : { content: result.content }),
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.references === undefined ? {} : { references: result.references }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };
}
```

This wrapper preserves method receivers and optional fields; its client already satisfies the neutral port. Adapt native SDK result unions first. See the [real MCP script](../../scripts/check-interaction-mcp-live.mjs) and [setup instructions](../../examples/README.md#mcp) for an executable official-SDK example. Ditto installs no MCP SDK and opens no transports automatically. Adapt SDK-specific result unions to McpToolResult. isError=true becomes failed, with MCP_TOOL_ERROR when no safe error object is available.

## 5. ExternalResult, OBSERVE, and messages

```ts
interface ExternalResult {
  callId: string; source: string;
  status: "success" | "failed" | "cancelled" | "timeout" | "unknown";
  content?: MessageContent; structuredContent?: JsonValue;
  references?: readonly Reference[]; error?: InteractionError; metadata?: JsonObject;
}
interface InteractionError { code: string; message: string; retryable?: boolean; }
interface Observation extends Omit<ExternalResult, "content"> { message: Message; }
interface Reference { uri: string; mediaType?: string; digest?: string; }
```

Success supplies at least one of content, structuredContent, or references; other statuses require error. Content/structuredContent/metadata must be JSON-compatible: no functions, BigInt, nonfinite numbers, cycles, or Date/Map-like objects. Reference uri is nonempty.

### observeExternalResult / INTERACTION.OBSERVE

The pure helper is synchronous; Node invocation is asynchronous. Both preserve correlation, status, structured data, references, error, and metadata, and generate a role=tool, name=source Message. A single text part becomes a string; other content becomes text/json/reference parts. Failures include a safe summary without being promoted to success. Neither retries nor updates CONTEXT.
```ts
export async function observeApis() {
  const result = { callId: "read-1", source: "read_text", status: "success" as const, content: "file text" };
  const local = observeExternalResult({ result });
  const runtime = createDitto({ workers: [createInteractionWorker()] });
  try {
    const routed = await runtime.invoke("INTERACTION.OBSERVE", { result });
    return { local, routed }; // message = { role: "tool", name: "read_text", content: "file text" }
  } finally { await runtime.close(); }
}
```

### Shared JSON / Message types

Import these from `@ditto/core/contracts` or the root package. INFER has its own model-specific Message contract; map content explicitly across Workers. MCP client discovery requires inputSchema for each tool, while the shared McpCapability type marks it optional.

```ts
export type JsonValue = string | number | boolean | null
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  name?: string;
}
export interface McpCapability {
  server: string; name: string; description?: string;
  inputSchema?: JsonObject; outputSchema?: JsonObject;
}
```

## 6. OUTPUT: requests and receipts

```ts
interface InteractionOutputInput {
  deliveryId: string; message: Message; artifacts?: readonly Artifact[];
}
interface Artifact { name: string; reference: Reference; }
interface OutputReceipt {
  deliveryId: string; status: "accepted" | "rejected" | "unknown";
  artifacts?: readonly Artifact[]; error?: InteractionError; metadata?: JsonObject;
}
```

deliveryId is nonempty and should identify one application delivery; Core performs no automatic deduplication. message.role is system/user/assistant/tool, normally assistant for final output. content is required and may be JSON null, numbers, objects, arrays, or text. Optional name is a string. Artifacts require nonempty names and URIs; Core passes references without writing or uploading files.
```ts
export async function outputApi() {
  const runtime = createDitto({ workers: [createInteractionWorker({ output: consoleSink })] });
  try {
    return await runtime.invoke("INTERACTION.OUTPUT", {
      deliveryId: "report-1", message: { role: "assistant", content: { summary: "Complete", count: 2 } },
      artifacts: [{ name: "report", reference: { uri: "urn:report:1", mediaType: "application/json" } }],
    }); // { deliveryId: "report-1", status: "accepted", artifacts: [...] }
  } finally { await runtime.close(); }
}
```

accepted means sink acceptance, not final delivery or reading. rejected/unknown require error. Invalid receipt IDs, artifacts, or metadata throw, without proving that delivery did not happen. Core does not automatically retry external effects.

## 7. Errors, permissions, and configuration

Tools can return business failures and sinks can reject delivery. Use safe structured errors rather than raw backend diagnostics:
```ts
export const missingRecordTool: RegisteredTool = {
  name: "lookup", inputSchema: { type: "object" }, validate() {},
  async execute() { return { status: "failed", error: { code: "NOT_FOUND", message: "No matching record", retryable: false } }; },
};
export const rejectedSink: OutputSink = {
  async deliver(input) { return { deliveryId: input.deliveryId, status: "rejected", error: { code: "DELIVERY_REJECTED", message: "The destination rejected the result" } }; },
};
```

Public error.code is at most 64 characters using letters, digits, underscores, dots, or hyphens. message is at most 512 characters and excludes newlines, controls, credential markers, absolute paths, and stack frames. retryable is descriptive and triggers no retry. Unsafe MCP business diagnostics receive a fixed replacement; invalid Tool/OUTPUT diagnostics are rejected.

| Configuration | Location |
| --- | --- |
| `tools / mcp / output / concurrency` | createInteractionWorker options |
| `tools / mcp / read / write / execute / network` | createDitto({ sandbox }) or explicitly loaded shared Sandbox env |
| `SDK endpoint / token` | Application env and connection code, not Graph input |
| `MCP discovery limits` | new McpRegistry({ maxDiscoveryPages, maxCapabilities }) |
| `workers.interaction YAML` | commands/webSearch behavior settings; explicitly pass config.interaction groups to factories |

Cancellation comes from Runtime call options through WorkerContext to tools/MCP/WebSearch providers, rather than from Node payload fields. Executors/applications own deadlines, retries and SDK cleanup. Stopping Runtime waiting does not imply stopping an external action. The Linux example explicitly injects SandboxExecutor; it is not a default Core capability. See the [Linux/macOS tool example](../../examples/interaction-tools.ts).

## 8. Lower-level composition

### createInteractionNodes(options?)

Options accept only `{ tools?: ToolRegistry, mcp?: McpRegistry, output?: OutputSink }`, not arrays or client maps. Returns WorkerNodes for composition with defineWorker capabilities such as expose/resources/dispose.
```ts
export function interactionNodes(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools, mcp, output: consoleSink }) });
}
```

### createToolHandler / createMcpHandler / createOutputHandler

Each takes its corresponding registry or sink and returns a typed NodeHandler. Use these for partial capabilities or custom handler composition; validation remains the same as the standard factory.
```ts
export function interactionHandlers(client: McpClient) {
  const tools = new ToolRegistry(); tools.register(readTextTool);
  const mcp = new McpRegistry(); mcp.register("files", client);
  return defineWorker({ type: "INTERACTION", nodes: {
    "INTERACTION.ACT.TOOL": createToolHandler(tools),
    "INTERACTION.ACT.MCP": createMcpHandler(mcp),
    "INTERACTION.OBSERVE": async input => observeExternalResult(input),
    "INTERACTION.OUTPUT": createOutputHandler(consoleSink),
  } });
}
```

### Node descriptors

interactionToolNode, interactionMcpNode, interactionObserveNode, and interactionOutputNode expose `.type` and `.define(workerType, handler)`. They identify semantics without registering or executing anything. Replacement handlers own the full contract; normally prefer createInteractionWorker.
```ts
export const observationDefinition = interactionObserveNode.define("INTERACTION", async input => observeExternalResult(input));
```

## 9. Graph + Loop + Worker and lifecycle

This Graph composes TOOL → OBSERVE → OUTPUT, while Loop iterates two files. Implementations remain inside the Worker. Paths and call IDs are Graph input; SDK clients and credentials are not.
```ts
export async function interactionGraph() {
  const runtime = createDitto({ sandbox: { tools: ["read_text"], read: true }, workers: [createInteractionWorker({ tools: [readTextTool], output: consoleSink })] });
  const plan = graph<{ path: string; id: string }>("read-and-deliver")
    .node("read", "INTERACTION.ACT.TOOL", [], input => ({ call: { id: input.id, name: "read_text", arguments: { path: input.path } } }))
    .node("observe", "INTERACTION.OBSERVE", ["read"], (_input, { read }) => ({ result: read }))
    .node("output", "INTERACTION.OUTPUT", ["observe"], (input, { observe }) => {
      if (observe.status !== "success") throw new Error(observe.error?.code ?? observe.status);
      return { deliveryId: `${input.id}:delivery`, message: { role: "assistant", content: observe.message.content } };
    });
  const paths = ["README.md", "package.json"];
  try {
    return await runtime.loop(loop({ graph: plan, maxIterations: paths.length,
      bind: (index: number) => ({ path: paths[index]!, id: `read:${index}` }),
      update: index => index + 1, done: index => index === paths.length,
    }), 0);
  } finally { await runtime.close(); }
}
```

Registering one Worker definition multiple times shares supplied tools, registries, clients, and sinks. Construct separate definitions or use defineWorker resources/dispose for independent resources. unregister only affects future lookups; it neither cancels started operations nor closes SDKs. Drain runtime.close() before closing application-owned clients.

See the [example guide](../../examples/README.md) for command, tool, and MCP composition. Database capabilities belong in MEMORY. Model action loops are documented in [ReAct Graph](../interaction-runtime.md#react-predefined-graph-flow).

## Compose with CONTEXT

Observe tool results before updating CONTEXT through ingress. Cached Graphs pass scope to UPDATE; runToolCallFlow/runMcpFlow use explicit Context. [Complete CONTEXT API and examples](context.md)。

```ts
export async function toolToCachedContext(
  runtime: import("@ditto/core").RuntimeClient,
  scope: import("@ditto/core/worker/context").ContextScope,
  call: import("@ditto/core/contracts").ToolCall,
) {
  const result = await runtime.invoke("INTERACTION.ACT.TOOL", { call });
  const observation = await runtime.invoke("INTERACTION.OBSERVE", { result });
  // The application chooses whether failed observations should enter its working set.
  if (observation.status !== "success") throw new Error(observation.error?.code ?? observation.status);
  return runtime.invoke("CONTEXT.UPDATE", { scope, ingress: [{
    id: `observation:${call.id}`, sourceNode: "INTERACTION.OBSERVE", content: observation.message.content,
    metadata: { callId: call.id, source: observation.source, status: observation.status },
  }] });
}
```

[Complete imports and source](examples/context.ts).

## Provider cancellation and bounded web responses

`WebSearchProvider.search(input, options?: WebSearchCallOptions)` accepts `{ signal?: AbortSignal }`; the tool supplies WorkerContext.signal. Brave's maxResponseBytes defaults to 1048576 and accepts 1–16777216. Streaming byte accounting stops oversized bodies and closes the stream before JSON parsing. timeoutMs defaults to 30000 and accepts 1–2147483647. Tool errors are sanitized: WEB_SEARCH_CANCELLED for cancellation, WEB_SEARCH_FAILED otherwise. Credentials and network permissions remain explicit.

```ts
import { createBraveWebSearchProvider, createReadOnlyCommandTools, createWebSearchTool } from "@ditto/core/worker/interaction";
import { loadRuntimeConfigFile } from "@ditto/core";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const provider = createBraveWebSearchProvider({
  apiKey: process.env.DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY!,
  ...config.interaction.webSearch,
});
const tools = [...createReadOnlyCommandTools(config.interaction.commands), createWebSearchTool({ provider })];
// Pass tools to createInteractionWorker and explicitly configure Sandbox permissions/executor.
```

`McpClient.listTools(params?, options?: McpCallOptions)` and `callTool(params, options?: McpCallOptions)` accept signal; McpRegistry.execute accepts it as the third argument. Discovery checks cancellation around every page. When adapting the neutral port to the official MCP SDK, listTools takes options second, while callTool takes options third: `client.callTool(params, undefined, options)`; the second argument is the result schema. See the [real MCP example](../../scripts/check-interaction-mcp-live.mjs). Custom RegisteredTool implementations can forward context.signal to Sandbox.run or their SDK.

Use the public `createLocalSandboxExecutor` factory or replace it with an application SandboxExecutor; see [Sandbox API](runtime.md#sandbox-api-and-local-execution) for configuration, permissions and examples. ReAct forwards its signal to sampling, action and observation Graphs, so tools receive cancellation through context.signal.
