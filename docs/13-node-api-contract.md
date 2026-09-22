# Ditto Node Taxonomy and API Contract

> [Detailed Worker APIs and examples](worker-api/README.md).

**English** | [简体中文](13-node-api-contract.zh-CN.md)


This document and the linked Worker APIs define the Node tree, semantic boundaries, common public types, and Node input/output contracts. A Node is a composable, independently executable semantic operation. A Worker is the implementation, resource, deployment, and scaling boundary. Graphs compose Nodes; Runtime schedules, routes, communicates, and executes them.

## Runtime predefined flows

Ditto exposes four directly callable Runtime functions from `src/runtime/graph.ts`. They compose existing Nodes and update the current Context; they are not Nodes and do not appear in `NodeContractMap`.

| Function | Standard flow |
| --- | --- |
| `runRagFlow()` | `CONTEXT.SELECT` with `strategy: { kind: "rag" }` |
| `runSkillFlow()` | `CONTEXT.LOAD → CONTEXT.UPDATE` (optional merge) |
| `runMcpFlow()` | `discover`: MCP only; `invoke`: MCP → OBSERVE → CONTEXT.UPDATE |
| `runToolCallFlow()` | TOOL → OBSERVE → CONTEXT.UPDATE |

Flows return `{ output, context }`; Tool/MCP invoke also return observation. RAG output is ContextSelection; Skill input is sources with optional context. Map Memory search results to UPDATE explicitly in the application Graph after checking NodeResult. See [CONTEXT API](worker-api/context.md).

## 1. Final Node tree

```text
INFER
├── REASONING/                  // folder, not a Node
│   ├── TRAJECTORY
│   │   └── CoT / ToT / GoT / ...  // strategies, not Nodes
│   ├── REFLECT
│   ├── DELIBERATE
│   └── SAMPLE
├── CACHE/
│   ├── LOOKUP
│   ├── WRITE
│   └── INVALIDATE
└── PROVIDERS/                  // implementation folder, not a Node

CONTEXT
├── LOAD
├── SELECT
├── UPDATE
└── COMPRESS

MEMORY
├── GET
├── QUERY
├── SEARCH
├── WRITE
├── UPDATE
└── DELETE

INTERACTION
├── ACT/
│   ├── TOOL
│   └── MCP
├── OBSERVE
└── OUTPUT
```

There are 21 Core routable leaf contracts. INFER.REASONING, INFER.CACHE, INFER.PROVIDERS, INTERACTION.ACT are namespaces; CACHE executes through LOOKUP, WRITE and INVALIDATE. Tool names and reasoning strategies are not Nodes.

## 2. Semantic boundaries

- **INFER** owns model computation. `REASONING` organizes explicit reasoning; it is not hidden model thought. `TRAJECTORY` accepts CoT/ToT/GoT through `strategy`; `REFLECT` revisits a result; `DELIBERATE` compares/combines candidates; `SAMPLE` generates one candidate. There is no separate Generate Node. Providers are implementation adapters, not Nodes. `CACHE` reuses computation results and is not Memory.
- **CONTEXT** owns the working set of the current invocation or turn. `LOAD`, `SELECT`, `UPDATE`, and `COMPRESS` alter that working set. Reset/session lifecycle belongs to Runtime. Context-to-model assembly is an internal `ModelInput` boundary, not a Node.
- **MEMORY** exposes GET / QUERY / SEARCH / WRITE / UPDATE / DELETE through injected MemoryStore / MemorySearchProvider ports; external plugins own databases.
- **RAG** is an internal CONTEXT.SELECT strategy using replaceable embed/retrieve/rank services; independent execution can delegate to RETRIEVAL.
- **SKILL** content is resolved by the application into sources and loaded through LOAD/UPDATE; MEMORY does not manage Skills.
- **INTERACTION** owns semantic interaction with the outside world. `ACT.TOOL` calls registered native tools; `ACT.MCP` discovers or invokes MCP capabilities; `OBSERVE` standardizes external results; `OUTPUT` submits the final result.

Task and user input enter through the application/Runtime boundary, not through a dedicated communication Node. A live external messaging system may be invoked through a registered Tool or MCP capability. Worker-to-Worker `invoke` and `emit` remain Runtime communication primitives. Location and transport never appear in Node Contracts.

## 3. Fixed common public types

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface Reference { uri: string; mediaType?: string; digest?: string; }
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "json"; data: JsonValue }
  | { type: "reference"; reference: Reference };
export type MessageContent = string | JsonValue | readonly MessagePart[];
export interface Message { role: MessageRole; content: MessageContent; name?: string; }

export interface ContextItem { id: string; content: MessageContent; source?: Reference; metadata?: JsonObject; }
export interface Context { items: readonly ContextItem[]; }
export type ContextSource = Message | Reference | ContextItem;
export interface ContextIngress {
  id: string; sourceNode: NodeType; content: MessageContent;
  reference?: Reference; metadata?: JsonObject;
}

export interface MemoryDraft { key?: string; content: unknown; metadata?: Record<string, unknown>; }
export interface MemoryItem extends MemoryDraft { id: string; }
export interface MemorySearchResult { memory: MemoryItem; score?: number; metadata?: Record<string, unknown>; }

export interface ToolCall { id: string; name: string; arguments: JsonObject; }
export type ToolEffect = "read" | "write" | "execute" | "network";
export interface ToolDefinition { name: string; description?: string; inputSchema: JsonObject; effects?: readonly ToolEffect[]; requiresApproval?: boolean; }
export interface ExternalResult {
  callId: string; source: string; status: "success" | "failed" | "cancelled" | "timeout" | "unknown";
  content?: MessageContent; structuredContent?: JsonValue; references?: readonly Reference[];
  error?: { code: string; message: string; retryable?: boolean }; metadata?: JsonObject;
}
export interface Observation extends Omit<ExternalResult, "content"> { message: Message; }
export interface Artifact { name: string; reference: Reference; }
export interface OutputReceipt { deliveryId: string; status: "accepted" | "rejected" | "unknown"; artifacts?: readonly Artifact[]; error?: { code: string; message: string; retryable?: boolean }; metadata?: JsonObject; }
export interface McpCapability { server: string; name: string; description?: string; inputSchema?: JsonObject; outputSchema?: JsonObject; }
```

## 4. Fixed Node inputs and outputs

```ts
import type { NodeResult } from "@ditto/core/contracts";
import type {
  TrajectoryInput, TrajectoryOutput, ReflectInput, ReflectOutput,
  DeliberateInput, DeliberateOutput, SampleInput, SampleOutput,
  CacheLookupInput, CacheLookupOutput, CacheWriteInput, CacheWriteOutput,
  CacheInvalidateInput, CacheInvalidateOutput,
} from "@ditto/core/worker/infer";

// Node inputs include explicit-context and scoped-cache calls.
import type { ContextInput, ContextOutput } from "@ditto/core/worker/context";
type ContextLoadInput = ContextInput<"CONTEXT.LOAD">;
type ContextLoadOutput = ContextOutput<"CONTEXT.LOAD">;
type ContextSelectInput = ContextInput<"CONTEXT.SELECT">;
type ContextSelectOutput = ContextOutput<"CONTEXT.SELECT">;
type ContextUpdateInput = ContextInput<"CONTEXT.UPDATE">;
type ContextUpdateOutput = ContextOutput<"CONTEXT.UPDATE">;
type ContextCompressInput = ContextInput<"CONTEXT.COMPRESS">;
type ContextCompressOutput = ContextOutput<"CONTEXT.COMPRESS">;

export interface MemoryGetInput { ids?: readonly string[]; keys?: readonly string[]; }
export type MemoryGetOutput = readonly MemoryItem[];
export interface MemoryQueryInput {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: readonly { field: string; direction?: "asc" | "desc" }[];
}
export interface MemoryQueryOutput { items: readonly MemoryItem[]; nextCursor?: string; }
export interface MemorySearchInput { query: unknown; strategy?: string; filter?: Record<string, unknown>; limit?: number; options?: Record<string, unknown>; }
export type MemorySearchOutput = readonly MemorySearchResult[];
export interface MemoryWriteInput { memories: readonly MemoryDraft[]; }
export type MemoryWriteOutput = readonly MemoryItem[];
export interface MemoryUpdateEntry { id: string; content?: unknown; metadata?: Record<string, unknown>; }
export interface MemoryUpdateInput { memories: readonly MemoryUpdateEntry[]; }
export type MemoryUpdateOutput = readonly MemoryItem[];
export interface MemoryDeleteInput { ids: readonly string[]; }
export interface MemoryDeleteOutput { deleted: readonly string[]; }

export interface InteractionToolInput { call: ToolCall; }
export type InteractionToolOutput = ExternalResult;
export type InteractionMcpInput =
  | { operation: "discover"; server?: string }
  | { operation: "invoke"; server: string; call: ToolCall };
export type InteractionMcpOutput =
  | { operation: "discover"; capabilities: readonly McpCapability[] }
  | { operation: "invoke"; result: ExternalResult };
export interface InteractionObserveInput { result: ExternalResult; }
export type InteractionObserveOutput = Observation;
export interface InteractionOutputInput { deliveryId: string; message: Message; artifacts?: readonly Artifact[]; }
export type InteractionOutputOutput = OutputReceipt;
```

```ts
export interface NodeContract<Input, Output> { readonly input: Input; readonly output: Output; }
export interface NodeContractMap {
  "INFER.REASONING.TRAJECTORY": NodeContract<TrajectoryInput, NodeResult<TrajectoryOutput>>;
  "INFER.REASONING.REFLECT": NodeContract<ReflectInput, NodeResult<ReflectOutput>>;
  "INFER.REASONING.DELIBERATE": NodeContract<DeliberateInput, NodeResult<DeliberateOutput>>;
  "INFER.REASONING.SAMPLE": NodeContract<SampleInput, NodeResult<SampleOutput>>;
  "INFER.CACHE.LOOKUP": NodeContract<CacheLookupInput, NodeResult<CacheLookupOutput>>;
  "INFER.CACHE.WRITE": NodeContract<CacheWriteInput, NodeResult<CacheWriteOutput>>;
  "INFER.CACHE.INVALIDATE": NodeContract<CacheInvalidateInput, NodeResult<CacheInvalidateOutput>>;
  "CONTEXT.LOAD": NodeContract<ContextLoadInput, ContextLoadOutput>;
  "CONTEXT.SELECT": NodeContract<ContextSelectInput, ContextSelectOutput>;
  "CONTEXT.UPDATE": NodeContract<ContextUpdateInput, ContextUpdateOutput>;
  "CONTEXT.COMPRESS": NodeContract<ContextCompressInput, ContextCompressOutput>;
  "MEMORY.GET": NodeContract<MemoryGetInput, NodeResult<MemoryGetOutput>>;
  "MEMORY.QUERY": NodeContract<MemoryQueryInput, NodeResult<MemoryQueryOutput>>;
  "MEMORY.SEARCH": NodeContract<MemorySearchInput, NodeResult<MemorySearchOutput>>;
  "MEMORY.WRITE": NodeContract<MemoryWriteInput, NodeResult<MemoryWriteOutput>>;
  "MEMORY.UPDATE": NodeContract<MemoryUpdateInput, NodeResult<MemoryUpdateOutput>>;
  "MEMORY.DELETE": NodeContract<MemoryDeleteInput, NodeResult<MemoryDeleteOutput>>;
  "INTERACTION.ACT.TOOL": NodeContract<InteractionToolInput, InteractionToolOutput>;
  "INTERACTION.ACT.MCP": NodeContract<InteractionMcpInput, InteractionMcpOutput>;
  "INTERACTION.OBSERVE": NodeContract<InteractionObserveInput, InteractionObserveOutput>;
  "INTERACTION.OUTPUT": NodeContract<InteractionOutputInput, InteractionOutputOutput>;
}
export type NodeType = keyof NodeContractMap;
export type InputOf<N extends NodeType> = NodeContractMap[N]["input"];
export type OutputOf<N extends NodeType> = NodeContractMap[N]["output"];
```

## 5. Implementation rules

- Every agreed leaf Node has an executable `.ts` implementation. Typed leaf descriptors support custom composition by binding identity and handlers; descriptors are not unfinished business implementations.
- INFER.CACHE is a namespace; LOOKUP, WRITE and INVALIDATE are implemented leaves.
- Providers live in `src/worker/infer/providers/`. Runtime and INFER share ModelProvider.invoke/stream and ProviderRegistry; see [Provider API](worker-api/providers.md). ReAct is a predefined Runtime graph flow, not an INFER strategy. Model/vendor changes do not create Nodes.
- `INTERACTION.ACT.TOOL` is represented by a source directory. Applications register tool or command implementations inside Workers; individual tool names are not Nodes.
- Tool and MCP registries remain distinct.
- The four predefined flows live in `src/runtime/graph.ts`; there is no `src/presets` package or export.
- Core remains dependency-light; databases, RPC, NATS, MCP SDKs, model SDKs, and distributed transports are optional adapters.
- The same Graph and Node Contracts must run across local and remote Workers without embedding deployment information.

## Optional RETRIEVAL extension

The four Core Workers retain 21 leaves. The optional `@ditto/core/worker/retrieval` entry adds the RETRIEVAL.SEARCH contract and implementation through explicit imports/registration. It invokes user providers through a Target/Strategy registry, owns no corpus, performs no RAG, and is not required by MEMORY/CONTEXT. Existing Runtime/HTTP facilities support independent deployment and replicas. See [API and deployment boundaries](worker-api/retrieval.md).
