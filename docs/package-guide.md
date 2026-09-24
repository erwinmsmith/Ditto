# npm package usage guide

[简体中文](package-guide.zh-CN.md) · [API reference](worker-api/README.md) · [Runnable basics](../examples/package-basics/README.md)

This guide starts with an empty npm project and covers Worker registration, Graph execution, Loop composition, real model and storage configuration, and reuse of the complete application examples. All framework imports use public package entries.

## 1. Choose the packages

| Package | Contents | Install when |
| --- | --- | --- |
| `@codesoul-co/ditto` | Runtime, Graph, Loop, INFER, CONTEXT, MEMORY, INTERACTION, contracts and Sandbox | Every Ditto application |
| `@codesoul-co/ditto-retrieval` | RETRIEVAL.SEARCH, providers and Memory/Context adapters | Your application uses these optional implementations |

Retrieval is a separate package with a peer dependency on Ditto. Installing the main package does not install or start retrieval. Redis, database drivers and other service SDKs remain application dependencies.

`@codesoul-co/ditto/runtime` is an exported entry inside the main package, not another package to install. The published entry names are not `@ditto/core`, `ditto`, `ditto/core` or the former `/worker/retrieval` subpath.

```sh
mkdir ditto-demo
cd ditto-demo
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto
# Optional:
npm install @codesoul-co/ditto-retrieval
```

Use Node.js 24+ and npm 11+. Packages contain ESM JavaScript and TypeScript declarations. There is no CommonJS `require()` build or browser Runtime. JavaScript consumers do not need TypeScript installed.

## 2. Make the first call

Create `app.mjs`:

```js
import { createDitto, createContextWorker, graph } from "@codesoul-co/ditto";

const runtime = createDitto({ workers: [createContextWorker()] });
const plan = graph("first-context")
  .node("loaded", "CONTEXT.LOAD", [], text => ({
    sources: [{ role: "user", content: text }],
  }))
  .node("selected", "CONTEXT.SELECT", ["loaded"], (_input, { loaded }) => ({
    context: loaded,
    purpose: "infer",
    limit: 1,
  }));

try {
  const result = await runtime.run(plan, "Hello Ditto");
  console.log(result.selected.context.items[0].content);
} finally {
  await runtime.close();
}
```

```sh
node app.mjs
# Hello Ditto
```

`loaded` and `selected` identify tasks inside this Graph. A task's dependency list determines which previous outputs its binding receives. This is a real Context API introduction with no external service, not a persistent Agent.

`createDitto()` does not automatically register Workers or read YAML/`.env`. This first call needs neither configuration file.

## 3. Run and check TypeScript

```sh
npm install --save-dev typescript @types/node
```

Consumer `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "types": ["node"],
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["app.ts", "examples/**/*.ts"],
  "exclude": ["examples/package-basics/retrieval.ts"]
}
```

The exclusion allows checking a main-package-only application. Remove it after installing retrieval. No `paths`, source symlinks or repository tsconfig are required.

Node 24 can execute the erasable TypeScript syntax used here with `node app.ts`; use `npx tsc -p tsconfig.json` for type checking. Applications may also compile their source, keeping relative runtime import extensions consistent with emitted files.

## 4. Understand the four pieces

| Concept | Responsibility | Application location |
| --- | --- | --- |
| Node | A semantic operation and its input/output contract, such as MEMORY.GET | Declared in Graphs |
| Worker | Implements Nodes and owns execution resources, concurrency and placement | Explicit startup registration |
| Graph | Dependencies and input bindings within one execution stage | Reusable application module |
| Loop | Coordinates Graphs, planning state and stopping conditions | Complete Agent entry |

Agent roles such as finance or research are application responsibilities, not Worker types. Changing a model, database or deployment location generally changes a Provider, adapter or Worker registration.

```ts
import { createDitto } from "@codesoul-co/ditto/runtime";
import { createInferWorker } from "@codesoul-co/ditto/worker/infer";
import { createContextWorker } from "@codesoul-co/ditto/worker/context";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
```

Importing factories or declaring a Graph does not register execution capability. Register with `createDitto({ workers: [...] })` or `runtime.register(worker)`.

## 5. Choose invoke, run or loop

| Call | Purpose | Result |
| --- | --- | --- |
| `runtime.invoke(node, input)` | One Node | That Node's output contract |
| `runtime.run(graph, input)` | One Graph | Outputs keyed by Graph task ID |
| `runtime.loop(plan, input)` | Stages, branches, retries or repetition | The chosen Loop definition's return value/final state |

Output shapes differ. CONTEXT returns Context or ContextSelection directly; INFER, MEMORY and RETRIEVAL return `NodeResult<T>`; tools return ExternalResult; OUTPUT returns a receipt. A resolved promise does not prove business success.

```ts
const result = await runtime.invoke("MEMORY.GET", { keys: ["user:alice:preferences"] });
if (result.status !== "success" || result.output === undefined) {
  throw new Error(result.error?.message ?? "Memory read failed");
}
console.log(result.output); // MemoryItem[], not result.output.items
```

Graphs do not automatically interpret every `NodeResult.status` as an exception. Check the result in the dependent binding or Loop before continuing. CONTEXT.SELECT returns `selection.context.items`, not model messages: message roles live in `item.metadata.role`, and content can be non-text. The complete example validates and converts these fields before inference.

## 6. Compose stages with Loop

Use a Loop plan to combine Graphs. Plans yield Graph invocations; they do not execute Workers, perform database I/O or nest Graph execution inside another Graph.

```ts
import { graphStep, loop } from "@codesoul-co/ditto/runtime";

const workflow = loop({
  id: "my-workflow",
  maxIterations: 4,
  *plan(input) {
    const loaded = yield* graphStep(loadGraph, input);
    const analyzed = yield* graphStep(analyzeGraph, loaded);
    return yield* graphStep(saveGraph, analyzed);
  },
});

const output = await runtime.loop(workflow, request, {
  concurrency: 2,
  signal: AbortSignal.timeout(120_000),
  onGraph(event) { console.log(event.graphId, event.status); },
});
```

`loadGraph`, `analyzeGraph` and `saveGraph` stand for Graphs defined by your application. See [agent.ts](../examples/package-basics/agent.ts) for the runnable implementation. In a generator plan, `maxIterations` bounds Graph executions, including failures. The alternative `loop({ graph, bind, update, done })` form returns final loop state.

Graph concurrency limits simultaneously running nodes without removing dependencies. Configure Worker concurrency and execution budgets separately for model, tool and queue resources.

## 7. Configure a real model

Create `.env` and replace placeholders with your provider's actual values:

```dotenv
DITTO_SHARED_PROVIDERS=primary
DITTO_SHARED_PROVIDER_PRIMARY_KIND=openai-compatible
DITTO_SHARED_PROVIDER_PRIMARY_BASE_URL=https://your-provider.example/v1
DITTO_SHARED_PROVIDER_PRIMARY_API_KEY=YOUR_API_KEY
DITTO_SHARED_PROVIDER_PRIMARY_MODEL=YOUR_MODEL_ID
DITTO_WORKER_INFER_MODEL_PROVIDER=primary
DITTO_WORKER_INFER_MODEL=YOUR_MODEL_ID
DITTO_SHARED_SANDBOX_ALLOW_NETWORK=https://your-provider.example
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379
```

`primary` is your configured Provider name and must match the default model's provider. `BASE_URL` is the API root expected by the provider. Network permissions contain origins without a `/v1` path. Supported provider kinds are `openai-compatible`, `anthropic` and `gemini`; see the [INFER API](worker-api/infer.md) for specific options.

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
const config = loadRuntimeConfig(process.env, {
  runtime: { timeoutMs: 60_000 },
  workers: { context: { cache: { ttlMs: 300_000 } } },
});
```

Start with `node --env-file=.env app.ts`. The loader parses the supplied environment and settings but does not load `.env` itself. Existing environment variables take precedence over Node's env file. For YAML use `loadRuntimeConfigFile("ditto.yaml", process.env)` with an application-owned file, not a path inside the installed package.

`createInferWorker()` reuses the Runtime's provider configuration. The complete Agent calls INFER.REASONING.SAMPLE through a Graph and checks status and answer content; inference alone is only one stage of the task.

## 8. Use Redis Context and database Memory

```sh
npm install redis@6.2.1
# Run in another terminal, or configure an existing Redis service.
redis-server --bind 127.0.0.1 --port 6379
```

Context is the short-lived working set; the example uses real Redis, TTL and explicit scope. Memory is the durable conversation and uses file SQLite through the MEMORY Worker. Business orders or approval tables do not replace Memory. The application creates and closes external clients.

The example reuses these application adapters:

| File under `examples/_shared/tools/storage/` | Responsibility |
| --- | --- |
| `redis-context.ts` | Connect the Redis SDK for Context |
| `sqlite-memory.ts` | File database, Memory schema, transactions and WAL |
| `sql-memory.ts` | Public MemoryStore and search implementation |
| `workers.ts` | Inject storage into the Workers and close connections |

These are application files, not business APIs exported by the npm package. Copy them with the example. Node SQLite needs no additional driver; its ExperimentalWarning is a Node notice, separate from actual database errors.

Scoped CONTEXT.LOAD without sources reads cached state; with sources it initializes/replaces that scope's context. The application chooses the recovery policy. The beginner Agent rebuilds each turn from Memory, so Redis need not retain history indefinitely. Redis connection failures still fail the task rather than falling back to memory.

For PostgreSQL, MySQL or vector storage implement/inject the corresponding public MemoryStore/MemorySearchProvider and run service-specific acceptance. The [storage guide](../examples/_shared/tools/storage/README.md) and [Memory examples](../examples/capabilities/memory/README.md) show integration points. SQLite verification does not imply those other databases were tested in the same environment.

## 9. Run the complete conversation Agent

```text
MEMORY.GET → check latest completed turn
  ├─ completed: output saved answer
  └─ new: CONTEXT.LOAD → SELECT → INFER.SAMPLE → CONTEXT.UPDATE
          → MEMORY.WRITE or UPDATE → INTERACTION.OUTPUT → answer file
```

One `runtime.loop(conversationPlan, ...)` owns all stages. Memory commits before output, so the latest turn can be retried with the same session, turn and prompt after interrupted delivery, without another inference.

From the repository root:

```sh
npm ci
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env.local
# Edit .env.local with real model configuration.
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt 'Remember my project code orchid-42.'
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt 'What is my project code?'
# Replay the latest completed turn in another process:
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt 'What is my project code?'
```

The default artifacts are `.examples-package-basics-tasks/alice/memory.sqlite` and `answers/turn-2.md`. CLI output includes `answer`, `file` and `replayed`. The same turn ID with a different prompt is rejected.

This beginner application serializes usage by convention: the trusted controller supplies session identity and a new turn ID for each request. Do not concurrently update one session or reuse older turn IDs after later turns finish. It supports replay of the latest turn and uses at most five prior turns in the next prompt. Authentication, tenant isolation, concurrent session serialization and business delivery idempotency belong to the host. For arbitrary checkpoints and long tasks use the [long-running pattern](../examples/patterns/long-running/README.md).

## 10. Copy the examples into your project

The npm package excludes repository examples and business tools. Keep a source checkout nearby as an example source, then copy application files while consuming the framework from npm:

```sh
# From ditto-demo; ../Ditto is the example repository.
mkdir -p examples/_shared/tools/storage/dependencies
cp -R ../Ditto/examples/package-basics examples/
cp ../Ditto/examples/_shared/tools/package-basics.ts examples/_shared/tools/
cp ../Ditto/examples/_shared/tools/storage/{workers,redis-context,sqlite-memory,sql-memory}.ts examples/_shared/tools/storage/
cp ../Ditto/examples/_shared/tools/storage/dependencies/package.json examples/_shared/tools/storage/dependencies/
npm install @codesoul-co/ditto redis@6.2.1
cp examples/package-basics/.env.example .env
# Edit .env and run agent.ts as above.
```

Preserve these relative locations. The Redis SDK resolves from the consumer's root node_modules. Do not copy framework source/dist, repository package.json, tests or local credentials.

Context/tools need only the main package; retrieval.ts needs the optional package. Repository `npm run example:*` scripts are not available in a new consumer unless you add them to its own package.json.

## 11. Add optional retrieval

```sh
npm install @codesoul-co/ditto-retrieval
node examples/package-basics/retrieval.ts Redis
```

The result contains the `context` document and `guide.md#context` reference. This provider filters two application documents by keyword; it does not create a database or vector index.

```ts
import { createRetrievalWorker, RetrievalTargetRegistry } from "@codesoul-co/ditto-retrieval";
import { RemoteRetrievalSearchProvider } from "@codesoul-co/ditto-retrieval/adapters/memory";
import { createRetrievalContextStrategy } from "@codesoul-co/ditto-retrieval/adapters/context";
```

Bind permitted targets and strategies explicitly and register the Worker. See [retrieval providers](worker-api/retrieval-providers.md) for database full-text, vectors, embedding and reranking. Full [RAG](../examples/patterns/rag-qa/README.md) adds selection, Context, generation and citation verification. Internal knowledge comes from approved Memory records; external enterprise knowledge uses its own Provider and access controls.

## 12. Adapt complete application patterns

| Need | Starting point | Application parts to replace |
| --- | --- | --- |
| Document Q&A | [RAG](../examples/patterns/rag-qa/README.md) | Identity, source catalog, authorization, model and output |
| Internet Q&A | [Web search](../examples/patterns/web-search-qa/README.md) | Search provider, permitted origins and page tools |
| Complex research | [Research](../examples/patterns/deep-research/README.md) | Subquestions, evidence storage, budgets and report output |
| Business writes | [Tool chain](../examples/patterns/tool-chain/README.md) | CRM/API adapters, identity and idempotency |
| Human approval | [Human-in-the-loop](../examples/patterns/human-in-the-loop/README.md) | Trusted approval controller, edits and publication adapter |
| Multiple agents | [Pattern index](../examples/patterns/README.md) | Specialist responsibilities, handoff and routing |
| Recovery | [Long-running](../examples/patterns/long-running/README.md) | Checkpoints, side-effect verification and controller |

Read each pattern's request format, trust boundary, dependencies, CLI, programmatic entry, failure branches and acceptance commands before copying it and its relative application dependencies. Functions such as `runRag` and `runAgent` belong to the example application, not additional Ditto package APIs.

## 13. Troubleshoot

| Symptom | Check |
| --- | --- |
| Cannot find package | Full scope, consumer package.json, optional package installation |
| Subpath is not exported | Use public entries, not src/dist or the old retrieval subpath |
| No available Worker | Factories must be explicitly registered |
| Provider not configured | Actual env-file loading, provider name and model ID |
| Network denied | Sandbox origin allowlist and provider API URL |
| Context store unavailable | Scoped calls need Redis/stateStore injection |
| Context not found | Scope identity or expired TTL; rebuild from durable Memory |
| Redis connection refused | Start/configure Redis; do not silently substitute local memory |
| Memory key conflict | Update existing content with MEMORY.UPDATE; use new keys for new tasks |
| Loop limit reached | Check Graph count and stopping conditions before changing budget |
| Output not accepted | Handle rejected/unknown receipts and verify the actual external write |

Close in this order: finish execution, close Runtime, close application databases and Redis. Runtime does not own the entire lifecycle of externally created SDK clients.

## 14. Verify package functionality

Repository commands below do not publish packages:

```sh
npm run check
npm run check:package:basics
npm run check:package:basics:live
npm run check:examples:control-flow:types
npm run check:examples:capabilities:types
```

The package gate first installs only the main tarball, checks every public entry, Context/tools, strict types and retrieval absence. It then installs retrieval and checks search plus TypeScript contract augmentation. Live acceptance runs two turns and replay in separate processes, expires Redis Context and inspects SQLite records and answer files.

After publishing, `node --env-file=.env scripts/check-package-basics.ts --registry --live` installs published versions for the same checks. Reports go to ignored `.examples-package-basics-*-live-results.json`; local tarballs go to `.release/`. Neither is committed as source.
