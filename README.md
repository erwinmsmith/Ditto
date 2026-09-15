<p align="center">
  <img src="./logo_project.png" alt="Ditto logo" width="280" />
</p>

<h1 align="center">Ditto</h1>

<p align="center">
  An agent-native framework for development nodes.<br />
  Scale on demand. Evolve agent structures at low cost.
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

> The project-owner-approved target classification and API definitions are documented in the [Node Taxonomy and API Contract](docs/13-node-api-contract.md). Runnable examples below still use current pre-migration `dev` Contracts until the TypeScript migration is implemented.

## Define the Graph First

Ditto is a lightweight TypeScript runtime for building Agents around a **Graph**. Declare the **Nodes**, their connections, and how upstream outputs form downstream inputs. Their owning **Workers** then supply implementations and execution resources.

A Graph can be expressed as **G = (V, E)**:

- **V: the set of Nodes.** Each vertex is a concrete operation, such as `MEMORY.RETRIEVE` or `REASONING.INFER`, whose implementation belongs to a Worker.
- **E: the set of directed connections.** `A → B` means B waits for A; a `bind` function transforms dependency results into B's input.

The following Graph connects retrieval, context loading, reasoning, and output. Names such as `retrieve` are logical IDs within the graph; names such as `MEMORY.RETRIEVE` identify the corresponding Node types:

```ts
import { graph, type Message } from "@ditto/core";

const agent = graph<Message>("retrieve-and-respond")
  .node("retrieve", "MEMORY.RETRIEVE", [], (query) => ({ query }))
  .node("context", "CONTEXT.LOAD", ["retrieve"], (_query, result) => ({
    sources: result.retrieve.map((item) => item.message),
  }))
  .node("infer", "REASONING.INFER", ["context"], (query, result) => ({
    messages: [query, ...result.context.items.map((item) => ({
      role: "user" as const, content: item.content,
    }))],
  }))
  .node("output", "INTERACTION.OUTPUT", ["infer"], (_query, result) => ({
    message: result.infer,
  }));
```

## Graph Connections

The four Nodes in the code are the four vertices below. The surrounding groups identify their owning Workers. The Runtime follows the Graph's dependencies and selects registered Worker replicas locally or remotely.

```mermaid
flowchart LR
  subgraph M["Worker: MEMORY"]
    R["retrieve<br/>MEMORY.RETRIEVE"]
  end
  subgraph C["Worker: CONTEXT"]
    L["context<br/>CONTEXT.LOAD"]
  end
  subgraph T["Worker: REASONING"]
    I["infer<br/>REASONING.INFER"]
  end
  subgraph X["Worker: INTERACTION"]
    O["output<br/>INTERACTION.OUTPUT"]
  end
  R --> L
  L --> I
  I --> O
```

The same structure can be expressed as an adjacency matrix. In the order `retrieve, context, infer, output`, **rows are sources and columns are destinations**. A `1` indicates a direct connection; a `0` indicates none:

| From ↓ / To → | retrieve | context | infer | output |
| --- | ---: | ---: | ---: | ---: |
| retrieve | 0 | 1 | 0 | 0 |
| context | 0 | 0 | 1 | 0 |
| infer | 0 | 0 | 0 | 1 |
| output | 0 | 0 | 0 | 0 |

The diagram and matrix describe the same dependencies; the `bind` functions in code define the actual data transformations. A Node type may appear multiple times with distinct logical IDs. Graphs are currently directed acyclic graphs (DAGs), with support for concurrent independent branches and joins across multiple dependencies.

**Nodes define capabilities, Graphs define one round, Loops advance state across rounds, and Workers execute Nodes.** An Agent is state + Graph + Loop. Register more Worker replicas to add capacity without changing the Graph definition.

## What is implemented

| Area | Support |
| --- | --- |
| Worker composition | Mixed Node namespaces, explicit public entries, per-replica resources, concurrency limits and cleanup |
| Graphs | Typed immutable DAGs; application-wide routing or execution pinned inside one Worker |
| Loops | `runtime.loop()` repeats a Graph with explicit state updates, stopping conditions, and an iteration limit |
| Communication | Direct local calls, authenticated HTTP across processes/servers, custom transport interface, separate events and artifacts |
| Models | Named providers, runtime defaults and per-Worker model selection; OpenAI-compatible and Anthropic text/tool adapters |
| Interaction Nodes | Validated single/batch tool calls, connected MCP client adapter, explicit Skill registration/loading |
| Configuration | Explicit environment parsing, model/key/timeout/workspace settings and default-deny permission services |

Core has **no third-party runtime dependencies**. The original 18 Node contracts remain at v1.0. The package is private and is not published to npm.

A Node is the abstract representation of an operation in a Graph, optionally defined with `defineNode(workerType, nodeType, handler)`. Each Node definition declares its owning Worker type; inline handlers are bound automatically, and Worker assembly rejects ownership mismatches. Workers provide the actual execution. Contracts and implementations live directly in their capability modules, without per-Worker `node/` directories, an Agent subsystem, or a Node class hierarchy.

```text
src/
  contracts/                # Shared messages/references and NodeContractMap registry
  worker/
    define-worker.ts        # defineWorker / extendWorker
    node.ts                 # Shared typed Node primitive
    execution-context.ts    # Worker resources and Runtime services
    memory/                 # Memory entities and operation contracts
    context/                # Context entities and operation contracts
    reasoning/              # contracts.ts, generate.ts and providers/
    interaction/            # contracts.ts, tools, MCP, Skills; leaf handler composition in index.ts
  runtime/                  # Graph/scheduler, registry, capability routing, lifecycle
    graph.ts                # One finite DAG: definition and execution
    loop.ts                 # State transitions and bounded repetition of a Graph
    runtime.ts              # invoke / run / loop, registration and lifecycle
    communication/          # Transport, HTTP and events
    sandbox/                # Runtime permission service
```

Memory and Context are contract-first extension points, not bundled databases or compression engines. Applications supply their handlers and per-Worker resources. Graph is part of Runtime, not a fourth subsystem.

## Quick start

Requirements: Node.js 24+ and npm 11+ (`.nvmrc` is included).

```bash
npm ci
npm run check
cp .env.example .env
```

`examples/` is reserved for future Agents built using the npm package and is currently empty. Configure a provider/model and permissions in `.env` for real models; see the [Interaction configuration guide](docs/interaction-runtime.md).

Use the `agent` Graph defined above. Supply application-owned Worker definitions implementing its four capabilities, then execute it through `runtime.run` to obtain the Node results:

```ts
import { createDitto, loadRuntimeConfig, type WorkerDefinition } from "@ditto/core";

async function runAgent(workers: readonly WorkerDefinition[], query: Message) {
  const runtime = createDitto({ config: loadRuntimeConfig(), workers });
  try {
    const result = await runtime.run(agent, query);
    return result.output;
  } finally {
    await runtime.close();
  }
}
```

The application implements and supplies `workers`; creating the Runtime registers those definitions. Provide the Memory/Context data strategies and Reasoning implementation your application needs, and configure a provider/model when using model adapters. The npm package has not been published yet.

## Run Multiple Rounds

`runtime.run(graph, input)` executes one DAG. `runtime.loop(definition, initialState)` executes successive rounds: `graph` supplies a fixed DAG or selects one from state, `bind(state)` supplies input, `update(state, output)` creates the next state, and `done(nextState, output)` decides whether to return it. The callbacks are synchronous. `maxIterations` defaults to 32 and must be a positive safe integer; reaching it without `done` throws. Node or callback errors propagate immediately without retries.

This complete composition uses the current model and tool capabilities. Configure the Provider/model in `.env`. The application registers tools in `tools` and allows them through `DITTO_ALLOW_TOOLS`; an empty registry supports a text-only conversation.

```ts
import {
  createDitto, defineWorker, graph, loop, loadRuntimeConfig,
  createGenerateNode, createInteractionNodes, ToolRegistry, type ModelMessage,
} from "@ditto/core";

interface AgentState { messages: readonly ModelMessage[]; turns: number }
const tools = new ToolRegistry();
const runtime = createDitto({ config: loadRuntimeConfig(), workers: [
  defineWorker({ type: "REASONING", nodes: {
    "REASONING.GENERATE": createGenerateNode({ tools: (ctx) => tools.list(ctx) }),
  } }),
  defineWorker({ type: "INTERACTION", nodes: createInteractionNodes({ tools }) }),
] });
const maxIterations = runtime.services.config.maxTurns;
const step = graph<AgentState>("agent-step")
  .node("response", "REASONING.GENERATE", [], (state) => ({ messages: state.messages }))
  .node("tools", "INTERACTION.TOOL_BATCH", ["response"], (state, { response }) => {
    if (response.toolCalls.length && state.turns + 1 >= maxIterations) {
      throw new Error("Agent turn limit reached");
    }
    return { calls: response.toolCalls };
  });
const agentLoop = loop({
  graph: step, maxIterations,
  bind: (state: AgentState) => state,
  update: (state, { response, tools }): AgentState => ({
    turns: state.turns + 1,
    messages: [
      ...state.messages,
      { role: "assistant", content: response.content, toolCalls: response.toolCalls },
      ...tools.map(({ id, result }) => ({
        role: "tool" as const, toolCallId: id, content: JSON.stringify(result),
      })),
    ],
  }),
  done: (_state, { response }) => response.toolCalls.length === 0,
});
try {
  const result = await runtime.loop(agentLoop, {
    messages: [{ role: "user", content: "Hello" }], turns: 0,
  });
  console.log(result.messages.at(-1)?.content);
} finally { await runtime.close(); }
```

Within each round the Graph is `REASONING.GENERATE → INTERACTION.TOOL_BATCH`. An empty batch does nothing; otherwise tools execute in order and their results enter the next round's messages. The application's Graph checks the final model turn before tool effects. The generic Loop only limits complete Graph executions and does not impose Agent-specific policies. `DITTO_MAX_TURNS` is used explicitly here; it does not change the generic default of 32.

`INTERACTION.RUN` has been removed. `createInteractionNodes({ tools, skills })` supplies tool and Skill handlers; model selection now belongs to `createGenerateNode({ model, tools })`. Load Skills explicitly with `runtime.invoke("INTERACTION.SKILL", { name })` and add their instructions to the initial state. See the [configuration guide](docs/interaction-runtime.md).

### Different DAGs for Different Steps

Keep multiple candidate Graphs in a collection and pass `graph: (state) => graphs[state.step]` to choose one per step. Candidates can be selected repeatedly, for example `draft → revise → draft`. The following text-only workflow drafts a response with one Node, then selects a two-Node review/revision DAG. Supply a live Runtime with `REASONING.GENERATE` registered without tools.

```ts
import { graph, loop, type DittoRuntime, type ModelMessage } from "@ditto/core";

interface ReviewState { messages: readonly ModelMessage[]; step: "draft" | "revise"; turns: number }
const draft = graph<ReviewState>("draft")
  .node("response", "REASONING.GENERATE", [], (state) => ({ messages: state.messages }));
const revise = graph<ReviewState>("revise")
  .node("critique", "REASONING.GENERATE", [], (state) => ({
    messages: [...state.messages, { role: "user", content: "Review the previous answer." }],
  }))
  .node("response", "REASONING.GENERATE", ["critique"], (state, { critique }) => ({
    messages: [...state.messages, { role: "user", content: `Revise using this feedback: ${critique.content}` }],
  }));
const graphs = { draft, revise };

async function runReview(runtime: DittoRuntime, messages: readonly ModelMessage[]) {
  return runtime.loop(loop({
    graph: (state: ReviewState) => graphs[state.step],
    bind: (state: ReviewState) => state,
    update: (state, { response }): ReviewState => ({
      step: "revise",
      turns: state.turns + 1,
      messages: [...state.messages, { role: "assistant", content: response.content }],
    }),
    done: (state) => state.turns === 2,
    maxIterations: 2,
  }), { messages, step: "draft", turns: 0 });
}
```

Each selected Graph can have different Nodes, edges, and parallel branches. Here both expose `response` to the Loop; if results differ, declare a union in `LoopDefinition<S, I, O>` and narrow it in `update` / `done`. The selector can also construct a new Graph from state. It runs once per iteration, and its errors stop the Loop before binding input or executing Nodes.

## Execution boundaries

`runtime.run(graph, input)` routes public Node capabilities across Workers. `ctx.run(graph, input)` runs the entire graph inside the current Worker replica, including private Nodes. `ctx.invoke(node, input)` explicitly routes another public capability.

`runtime.loop()` uses `runtime.run()` for each round, so replicas may change between rounds. Keep conversation state in the Loop state or explicitly shared storage. Finish top-level runs before closing the Runtime. Loop does not introduce cycles into Graphs, checkpointing, cancellation, or automatic retries.

Scaling is manual registration/deployment; automatic provisioning and durable workflow recovery are not implemented. HTTP timeouts do not cancel remote effects, and calls are not automatically retried. Sandbox provides cooperative permission checks; untrusted code requires an application-supplied OS/container isolation boundary. MCP connections and external client lifecycles are owned by the application.

## Documentation

Start with the [documentation map](docs/README.md). All guides are available in English and Simplified Chinese:

- [Architecture and extension boundaries](docs/architecture.md)
- [Development and package integration](docs/getting-started.md)
- [Local and remote Worker communication](docs/worker-communication.md)
- [Providers, tools, MCP, Skills and Sandbox](docs/interaction-runtime.md)
- [Node API v1.0 contract](docs/13-node-api-contract.md)

Use [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) for concrete use cases, bugs and architecture discussions.
