# Development and Integration

**English** · [简体中文](getting-started.zh-CN.md)

## Environment and Checks

Use Node.js 24+ and npm 11+. `.nvmrc` selects Node 24. There are no third-party runtime dependencies; TypeScript and Node types are development dependencies only.

```bash
nvm use
npm ci
npm run check
```

`check` runs strict type checking, behavior tests, and the build. CI runs the same checks. `dist/` contains the package's compiled output. The package is private and has not been published to npm.

## Configuration and Future Examples

Copy `.env.example` to `.env`, then configure providers, models, keys, and permissions using [Interaction and Runtime Configuration](interaction-runtime.md). The library does not load environment files implicitly; application startup code loads them explicitly and calls `loadRuntimeConfig()`.

`examples/` is currently empty and reserved for complete examples that build different Agents using the npm package. The package has not been published; the snippets below explain the API only.

Public entries are `@ditto/core`, `contracts`, `worker`, `worker/node`, `worker/memory`, `worker/context`, `worker/infer`, `worker/infer/providers`, `worker/interaction`, `runtime`, and `runtime/sandbox`. The former top-level `node` / `agent` / `providers` / `presets` / `sandbox` entries are not retained. The root entry still provides general exports, including the four Runtime flow functions.

Initialize built-in or previously declared extension namespaces with short operation names:

```ts
import { extendWorker } from "@ditto/core/worker";
const memory = extendWorker("MEMORY", {
  nodes: { RETRIEVE: async (_input) => [] },
});
```

The empty result here illustrates only the contract. The Memory Worker's resources and handlers supply actual retrieval logic and database connections. `extendWorker` creates a new definition; it neither supplies missing operations nor modifies deployed Workers.

## Creating Nodes and Worker Instances

`defineNode(workerType, nodeType, handler)` creates an immutable `{ workerType, type, execute }` definition. The first argument is mandatory. For example, `defineNode("MEMORY", "MEMORY.RETRIEVE", handler)` declares a Node owned by the MEMORY Worker type. Mounting it in a Worker with a different type fails during definition, before any resources are created. The previous two-argument form is no longer supported.

A function supplied directly in `Worker.nodes` is automatically bound to that Worker. A Node's semantic name remains independent of its owning Worker's deployment role: a custom `assistant` Worker can explicitly own a REASONING Node. The owner must match the Worker that actually mounts the definition, not necessarily the Node name's prefix.

Creating a Worker has two stages:

1. `defineWorker({ type, nodes, ... })`, or `extendWorker(type, { nodes, ... })` with short operation names, creates a Worker definition. It must contain at least one implemented Node and expose at least one implemented entry.
2. `runtime.register(worker)` creates a replica and its resources. Register again for another independent replica; use the returned handle's `close()` to drain and release it.

Defining a Node or Worker does not register it automatically. Runtime execution always selects a registered Worker, including for internal Graphs. There is no standalone Node registration API. Ownership is associated with a Worker type; multiple replicas of that type may use the same immutable definition. This is an API composition rule, not an OS isolation boundary for directly called JavaScript functions.

For a new semantic Node, declare its input/output in NodeContractMap and provide the handler. The following example creates a custom Worker with a new SEARCH.QUERY Node:

## Custom Workers and Nodes

```ts
import { createDitto, defineWorker, defineNode, type NodeContract } from "@ditto/core";

declare module "@ditto/core/contracts" {
  interface NodeContractMap {
    "SEARCH.QUERY": NodeContract<{ query: string }, readonly { title: string }[]>;
  }
}

const search = defineWorker({
  type: "research-assistant",
  concurrency: 4,
  expose: ["SEARCH.QUERY"],
  resources: () => ({ queries: 0 }),
  nodes: {
    "SEARCH.QUERY": defineNode<"SEARCH.QUERY", { queries: number }>(
      "research-assistant", "SEARCH.QUERY",
      async (input, ctx) => {
        ctx.resources.queries++;
        return [{ title: input.query }];
      },
    ),
  },
});

const runtime = createDitto({ workers: [search] });
try {
  runtime.register(search); // New replica, new resources
  console.log(await runtime.invoke("SEARCH.QUERY", { query: "hello" }));
} finally {
  await runtime.close();
}
```

Add a Node through declaration merging and a handler. Change models through Provider/model configuration. Do not add keys, hosts, transports, or sandbox fields to fixed business inputs.

Use `ctx.run` to compose an internal Worker Graph and `ctx.invoke` for cross-Worker calls. See [Architecture](architecture.md) for their semantics and usage.
