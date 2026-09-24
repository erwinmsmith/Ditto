<p align="center">
  <img src="https://raw.githubusercontent.com/erwinmsmith/Ditto/dev/logo_project.png" alt="Ditto logo" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  A lightweight Node-native Runtime for composable Agent systems.<br />
  Scale Workers without changing Graphs or Node Contracts.
</p>

<p align="center">
  <strong>English</strong> | <a href="https://github.com/erwinmsmith/Ditto/blob/dev/README.zh-CN.md">简体中文</a>
</p>

> The definition is [Node System and API Contract](https://github.com/erwinmsmith/Ditto/blob/dev/docs/13-node-api-contract.md). It contains the final Node tree, semantic boundaries, fixed shared types, and every public Node input/output contract.

## Architecture

Ditto separates four concepts:

- **Node**: the smallest routable semantic operation;
- **Worker**: the implementation, resource, deployment, and scaling boundary;
- **Execution Graph**: a location-independent composition of Nodes;
- **Runtime**: scheduling, routing, communication, and execution.

Changing a model, database, tool Provider, deployment location, or replica count does not create a new Node Type. Runtime communication uses `invoke` for request/response and `emit` for asynchronous events; neither is an Interaction Node.

## Final Node Domains

- `INFER.REASONING.*`: explicit reasoning organization (`TRAJECTORY`, `REFLECT`, `DELIBERATE`, `SAMPLE`);
- `INFER.CACHE.*`: inference cache `LOOKUP`, `WRITE`, and `INVALIDATE`;
- `CONTEXT.*`: the current invocation/turn working set, including task-local RAG and activated Skills;
- `MEMORY.*`: durable storage and search through GET / QUERY / SEARCH / WRITE / UPDATE / DELETE;
- `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`: external actions;
- `INTERACTION.OBSERVE` / `INTERACTION.OUTPUT`: normalized observations and final output.

`INFER/PROVIDERS` is an implementation directory, not a Node. `INFER/REASONING` is also a source directory rather than a `REASONING` Node. Inject tools through `createInteractionWorker({ tools, mcp, output })`; individual tools, Linux commands, and web search providers do not create additional Node Types. `createReadOnlyCommandTools()` offers 14 optional bounded search, reading, text-processing, metadata, disk-usage, and workspace-location commands. `createWebSearchTool()` accepts an application-injected provider; `createBraveWebSearchProvider()` is the first native-fetch adapter. Neither helper is registered or permitted by default.

RETRIEVAL is an optional independently deployable search Worker exposing only `RETRIEVAL.SEARCH`. Import and register `@codesoul-co/ditto-retrieval` explicitly; Core does not load it by default. Existing direct MEMORY/CONTEXT providers remain available. See the [RETRIEVAL API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/retrieval.md).

## Predefined Runtime Flows

Four public compositions live directly in `src/runtime/graph.ts` and are exported from `@codesoul-co/ditto/runtime`:

```text
runRagFlow          CONTEXT.SELECT (rag strategy)
runSkillFlow        CONTEXT.LOAD -> CONTEXT.UPDATE (when context is supplied)
runToolCallFlow      INTERACTION.ACT.TOOL   -> INTERACTION.OBSERVE -> CONTEXT.UPDATE
runMcpFlow           INTERACTION.ACT.MCP    -> INTERACTION.OBSERVE -> CONTEXT.UPDATE (invoke)
```

These Runtime functions use explicit Context. RAG is an internal SELECT strategy; applications resolve Skill content for LOAD/UPDATE. See the [CONTEXT API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/context.md) for cached calls, Redis and examples.

```ts
import { runRagFlow, runToolCallFlow } from "@codesoul-co/ditto/runtime";

const retrieved = await runRagFlow(runtime, {
  context: { items: [] },
  query: "Find the relevant API definition",
  corpus: { uri: "urn:contracts" }, // Resolved by the configured ragStrategy.
});

const toolResult = await runToolCallFlow(runtime, {
  context: retrieved.context,
  call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
});
```

## Graphs and Workers

Graphs contain semantic Node Types and data bindings, never Worker IDs or network addresses:

```ts
import { randomUUID } from "node:crypto";
import { graph, type Message } from "@codesoul-co/ditto";

const review = graph<Message>("review")
  .node("memories", "MEMORY.GET", [], () => ({
    keys: ["review-policy"],
  }))
  .node("context", "CONTEXT.LOAD", ["memories"], (query, { memories }) => {
    if (memories.status !== "success" || !memories.output) throw new Error("Memory read failed");
    return { sources: [query, ...memories.output.map(memory => ({
      id: memory.id, content: typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content),
    }))] };
  })
  .node("reason", "INFER.REASONING.TRAJECTORY", ["context"], (_query, { context }) => ({
    messages: [{ role: _query.role, content: typeof _query.content === "string"
      ? _query.content : JSON.stringify(_query.content) }],
    context: context.items.map(item => ({ id: item.id, content: item.content })),
    model: { model: "your-model-name" },
    strategy: { name: "cot" },
  }))
  .node("output", "INTERACTION.OUTPUT", ["reason"], (_query, { reason }) => {
    if (reason.status !== "success" || reason.output?.status !== "completed") {
      throw new Error(reason.error?.message ?? "Trajectory incomplete");
    }
    return { deliveryId: randomUUID(), message: { role: reason.output.result.role,
      content: typeof reason.output.result.content === "string"
        ? reason.output.result.content : JSON.stringify(reason.output.result.content) } };
  });
```

Registering more Worker replicas adds capacity without changing this Graph. The same contracts support local execution, multiple Workers, multiple processes, or custom remote transports.

See the [INFER Worker API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/infer.md) for setup and all seven leaf contracts.

Define an Agent with Graph → Loop → Worker; run the complete [graph-loop-worker.ts](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/examples/graph-loop-worker.ts) example using `npm run example:agent`. See [Interaction setup](https://github.com/erwinmsmith/Ditto/blob/dev/docs/interaction-runtime.md#graph-loop-and-worker-setup) for Tool and MCP wiring.

## Repository Structure

```text
src/
├── contracts/                    # shared fixed types and open NodeContractMap
├── runtime/
│   ├── graph.ts                  # DAG plus four predefined flows
│   ├── runtime.ts                # routing and lifecycle
│   └── communication/            # invoke/emit, transports, artifacts
└── worker/
    ├── infer/
    │   ├── reasoning/            # reasoning leaves and node scaffolds
    │   ├── cache/                # LOOKUP / WRITE / INVALIDATE
    │   └── providers/            # shared provider registry and wire protocols
    ├── context/
    ├── memory/
    └── interaction/act/tool/     # Tool Node, registry, implementation folders
```

The optional SEARCH Worker lives in `packages/retrieval/` and is published separately as `@codesoul-co/ditto-retrieval`.

Core uses only the `yaml` parser as a third-party runtime dependency. Heavy RPC, event buses, MCP SDKs, database drivers, and model SDKs remain optional application/adapter choices.

## Development

Requirements: Node.js 24+ and npm 11+.

```bash
npm ci
npm run check
```

Install the Runtime with `npm install @codesoul-co/ditto`. Applications that use the optional search Worker also install `@codesoul-co/ditto-retrieval`.

See the [Runtime API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/runtime.md) and [complete examples](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/examples/runtime/README.md) for node bindings, independent sandboxes, loops and local IPC / cross-host HTTP.

## Documentation

- [Examples: control flow, capabilities and execution patterns](https://github.com/erwinmsmith/Ditto/blob/dev/examples/README.md) (run `npm run example:quickstart` for a local introduction)
- [Node System and API Contract](https://github.com/erwinmsmith/Ditto/blob/dev/docs/13-node-api-contract.md)
- [Architecture and extension boundaries](https://github.com/erwinmsmith/Ditto/blob/dev/docs/architecture.md)
- [Development and package integration](https://github.com/erwinmsmith/Ditto/blob/dev/docs/getting-started.md)
- [Worker communication and deployment](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-communication.md)
- [Providers, Interaction, and predefined flows](https://github.com/erwinmsmith/Ditto/blob/dev/docs/interaction-runtime.md)

Use [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) for concrete use cases, bugs, and architecture discussions.

Behavior defaults live in root [`ditto.yaml`](https://github.com/erwinmsmith/Ditto/blob/dev/ditto.yaml); credentials and deployment bindings use [`.env.example`](https://github.com/erwinmsmith/Ditto/blob/dev/.env.example). All Workers share Runtime services; see the [configuration API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/configuration.md). See the [INFER example guide](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/examples/guide.md#infer) for setup and commands.

See the [MEMORY API](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/memory.md) for plugin wiring, six node contracts and configuration.

More public APIs and examples: [Worker composition / events / Artifacts](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/composition.md), [predefined flows](https://github.com/erwinmsmith/Ditto/blob/dev/docs/worker-api/flows.md), and the [local quickstart](https://github.com/erwinmsmith/Ditto/blob/dev/examples/quickstart.ts).
