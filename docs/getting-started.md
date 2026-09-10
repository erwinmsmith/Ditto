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

Public entries are `@ditto/core`, `contracts`, `worker`, `worker/node`, `worker/memory`, `worker/context`, `worker/reasoning`, `worker/reasoning/providers`, `worker/interaction`, `runtime`, and `runtime/sandbox`. The former top-level `node` / `agent` / `providers` / `sandbox` entries are not retained. The root entry still provides general exports.

Initialize built-in or previously declared extension namespaces with short operation names:

```ts
import { extendWorker } from "@ditto/core/worker";
const memory = extendWorker("MEMORY", {
  nodes: { RETRIEVE: async (_input) => [] },
});
```

The empty result here illustrates only the contract. The Memory Worker's resources and handlers supply actual retrieval logic and database connections. `extendWorker` creates a new definition; it neither supplies missing operations nor modifies deployed Workers.

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
      "SEARCH.QUERY",
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
