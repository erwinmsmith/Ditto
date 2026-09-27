# Development and integration

**English** · [简体中文](getting-started.zh-CN.md)

For npm installation, real models and storage, persistent tasks and independent consumers, follow the [complete package guide](package-guide.md) and [runnable basics](../examples/package-basics/README.md).

## Install and run

Use Node.js 24+ and npm 11+; `.nvmrc` selects Node 24. From the repository root:

```bash
nvm use
npm ci
npm run example:runtime:quickstart
npm run check
```

The npm ci prepare hook builds dist; example commands also build first. check runs strict type checking, builds and behavior tests. The first example uses local Context and needs no .env, model key, Redis or database. Complete code: [quickstart.ts](../examples/quickstart.ts).

```ts
import assert from "node:assert/strict";
import { createDitto, graph } from "@codesoul-co/ditto/runtime";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
```
```ts
export async function quickstart() {
  const runtime = createDitto({ workers: [createContextWorker()] });
  const plan = graph<string>("first-context")
    .node("loaded", "CONTEXT.LOAD", [], text => ({ sources: [{ role: "user", content: text }] }))
    .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
      context: loaded, purpose: "infer", limit: 1,
    }));
  try {
    const output = await runtime.run(plan, "Hello Ditto", { concurrency: 2 });
    assert.equal(output.selected.context.items[0]?.content, "Hello Ditto");
    return output.selected;
  } finally { await runtime.close(); }
}
```

The result is a ContextSelection containing purpose/context/selectedItemIds. SELECT does not return messages; map them as shown in [Context](worker-api/context.md) before calling a model. This example passes explicit Context; caching requires an injected Redis/other ContextStateStore and scoped calls.

## Use from another project

In an application with an initialized package.json, install Ditto from npm:

```bash
npm install @codesoul-co/ditto
# Add this only when using the optional retrieval Worker:
npm install @codesoul-co/ditto-retrieval
```

Use ESM (type=module in application package.json); TypeScript can use module/moduleResolution=NodeNext and target=ES2024. Import public entry points rather than internal src/dist paths. Extend [NodeContractMap](worker-api/composition.md) for typed application nodes.

## Public package entries

| Import | API |
| --- | --- |
| `@codesoul-co/ditto` | Core Runtime + Worker factories + contracts + Sandbox + checkpoints + BranchStore + TokenBudget |
| `@codesoul-co/ditto/contracts` | NodeContract / NodeContractMap / InputOf / OutputOf / shared types |
| `@codesoul-co/ditto/worker` | defineWorker / extendWorker / defineNode / createNodeScaffold / core factories |
| `@codesoul-co/ditto/worker/node` | defineNode / NodeHandler / WorkerContext / RuntimeClient |
| `@codesoul-co/ditto/runtime` | createDitto / graph / loop / flows / config / services / transports / events / artifacts / checkpoints / budgets |
| `@codesoul-co/ditto/runtime/sandbox` | Sandbox / PermissionDeniedError / createLocalSandboxExecutor |
| `@codesoul-co/ditto/worker/context` | CONTEXT SDK / factory / stores / strategies / resolver |
| `@codesoul-co/ditto/worker/infer` | INFER SDK / factory / reasoning / cache / providers |
| `@codesoul-co/ditto/worker/infer/providers` | ModelProvider / ProviderRegistry / HTTP adapters |
| `@codesoul-co/ditto/worker/memory` | MEMORY SDK / factory / store and search interfaces |
| `@codesoul-co/ditto/worker/interaction` | Factory / tool and MCP registries / handlers / command and web tools |
| `@codesoul-co/ditto-retrieval` | Optional RETRIEVAL SDK / factory / embedding / retrieval providers |
| `@codesoul-co/ditto-retrieval/adapters/memory` | MEMORY ↔ RETRIEVAL adapters |
| `@codesoul-co/ditto-retrieval/adapters/context` | CONTEXT RAG ↔ RETRIEVAL adapters |

The root entry does not automatically import the optional RETRIEVAL implementation. Explicit subpath imports still require Provider configuration and Worker registration; definitions, type declarations and registration are separate steps.

## Configuration and integration order

1. Define semantic nodes, dependencies and bindings in a Graph; add Loop state updates and termination when repetition is needed.
2. Select Worker implementations: model Provider, MemoryStore/search, ContextStateStore and Tool/MCP/OutputSink.
3. Explicitly load behavior settings from root ditto.yaml and environment bindings, create Runtime services and register Workers.
4. Execute invoke/run/loop, check each result type, and close Runtime plus application-owned SDKs in finally.

`createDitto()` does not read process.env or YAML by default. `loadRuntimeConfigFile("ditto.yaml", process.env)` reads YAML and consumes the supplied environment. Reading .env requires Node --env-file=.env or an application loader. Copy .env.example only when external bindings are needed. See [configuration](worker-api/configuration.md) for grouping and precedence. Pass Worker-specific options to factories explicitly, as with Context policy above.

The root also exports `NODE_API_VERSION` (currently `2.0-rc.1`) for contract-version metadata in logs; it does not negotiate transport protocols. `Infer` is a type-only namespace; use createInfer/createInferWorker for runtime factories.

```ts
import { NODE_API_VERSION } from "@codesoul-co/ditto";
console.log(NODE_API_VERSION);
```

## Next steps

| Task | Reference and runnable command |
| --- | --- |
| Agent loop, real tools and output | [Graph + Loop + Worker](worker-api/examples/graph-loop-worker.ts): `npm run example:agent` |
| Custom/private nodes, resources, events and Artifacts | [Composition](worker-api/composition.md): `npm run example:runtime:api` |
| RAG / Skill / Tool / MCP / ReAct | [Flows](worker-api/flows.md): `npm run example:runtime:flows` |
| Graph/Loop, separate Sandbox, IPC/HTTP | [Runtime](worker-api/runtime.md): `npm run example:runtime:placement` |
| Resume explicit state and share token admission | [Checkpoints and budgets](worker-api/checkpoints.md) |
| Context Redis, Memory SQL/Milvus, independent Retrieval | [Database examples](worker-api/examples/integrations/README.md) |
| All Workers, Providers and individual APIs | [API index](worker-api/README.md) |
