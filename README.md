<p align="center">
  <img src="./logo_project.png" alt="Ditto logo" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  A lightweight Node-native Runtime for composable Agent systems.<br />
  Scale Workers without changing Graphs or Node Contracts.
</p>

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

> The definition is [Node System and API Contract](docs/13-node-api-contract.md). It contains the final Node tree, semantic boundaries, fixed shared types, and every public Node input/output contract.

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
- `MEMORY.*`: durable cross-invocation semantic state, including Memory RAG and stored Skills;
- `INTERACTION.ACT.TOOL` / `INTERACTION.ACT.MCP`: external actions;
- `INTERACTION.OBSERVE` / `INTERACTION.OUTPUT`: normalized observations and final output.

`INFER/PROVIDERS` is an implementation directory, not a Node. `INFER/REASONING` is also a source directory rather than a `REASONING` Node. Tool implementations are organized under `interaction/act/tool/`; the `linux-commands/` folder contains registered tool names, not additional Node Types.

## Predefined Runtime Flows

Four public compositions live directly in `src/runtime/graph.ts` and are exported from `@ditto/core/runtime`:

```text
runRagFlow(context)  CONTEXT.RAG.RETRIEVE -> CONTEXT.RAG.RANK -> CONTEXT.UPDATE
runRagFlow(memory)   MEMORY.RAG.RETRIEVE  -> MEMORY.RAG.RANK  -> CONTEXT.UPDATE
runSkillFlow         MEMORY.SKILL          -> CONTEXT.UPDATE
runToolCallFlow      INTERACTION.ACT.TOOL   -> CONTEXT.UPDATE
runMcpFlow           INTERACTION.ACT.MCP    -> CONTEXT.UPDATE
```

These are functions, not Nodes. They provide standard ingress into `CONTEXT.UPDATE`; applications remain free to compose the same leaf Nodes differently. RAG `EMBED` is index preparation and is intentionally outside the query-time flow.

```ts
import { runRagFlow, runToolCallFlow } from "@ditto/core/runtime";

const retrieved = await runRagFlow(runtime, {
  scope: "context",
  context: { items: [] },
  query: "Find the relevant API definition",
  corpus: [{ id: "contract", content: "..." }],
});

const toolResult = await runToolCallFlow(runtime, {
  context: retrieved.context,
  call: { id: "read-1", name: "read_text", arguments: { path: "README.md" } },
});
```

## Graphs and Workers

Graphs contain semantic Node Types and data bindings, never Worker IDs or network addresses:

```ts
import { graph, type Message } from "@ditto/core";

const review = graph<Message>("review")
  .node("memories", "MEMORY.RETRIEVE", [], () => ({
    selector: { keys: ["review-policy"] },
  }))
  .node("context", "CONTEXT.LOAD", ["memories"], (query, { memories }) => ({
    sources: [query, ...memories.map((memory) => memory.message)],
  }))
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
    return { message: { role: reason.output.result.role,
      content: typeof reason.output.result.content === "string"
        ? reason.output.result.content : JSON.stringify(reason.output.result.content) } };
  });
```

Registering more Worker replicas adds capacity without changing this Graph. The same contracts support local execution, multiple Workers, multiple processes, or custom remote transports.

See the [INFER Worker API](docs/worker-api/infer.md) for setup and all seven leaf contracts.

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

Core uses only the `yaml` parser as a third-party runtime dependency. Heavy RPC, event buses, MCP SDKs, database drivers, and model SDKs remain optional application/adapter choices.

## Development

Requirements: Node.js 24+ and npm 11+.

```bash
npm ci
npm run check
```

The package is currently private and is not published to npm. Other experiment repositories can consume it through a local Git or workspace dependency; the existing package exports are designed to remain valid when npm publication begins.

## Documentation

- [Node System and API Contract](docs/13-node-api-contract.md)
- [Architecture and extension boundaries](docs/architecture.md)
- [Development and package integration](docs/getting-started.md)
- [Worker communication and deployment](docs/worker-communication.md)
- [Providers, Interaction, and predefined flows](docs/interaction-runtime.md)

Use [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) for concrete use cases, bugs, and architecture discussions.

Behavior defaults live in root [`ditto.yaml`](ditto.yaml); credentials and deployment bindings use [`.env.example`](.env.example). All Workers share Runtime services; see the [configuration API](docs/worker-api/configuration.md). Run `npm run check:infer:live -- --provider deepseek` explicitly; see the [INFER live verification report](docs/worker-api/infer-live-report.md).
