# Project structure and a complete Agent

This chapter moves from calling a model to running a stateful application. The entry point accepts `session`, `turn` and `prompt`, reads history from Memory, manages working context in Redis, generates an answer, saves the conversation and writes an answer file.

## 1. Create an npm application

Use Node.js 24+ and npm 11+. In a new directory:

```sh
npm init -y
npm pkg set type=module
npm install @codesoul-co/ditto redis@6.2.1
npm install --save-dev typescript @types/node
```

This example does not need the optional retrieval package. The application loads `.env`; model keys do not belong in Graphs or request payloads.

## 2. Suggested project layout

```text
my-agent/
  package.json
  tsconfig.json
  .env                    # Local configuration; never commit secrets
  src/
    main.ts               # Entry point and request validation
    runtime.ts            # Connections, Worker registration and cleanup
    contracts.ts          # Requests, plans, results and checkpoints
    graphs/
      history.ts          # MEMORY.GET
      answer.ts           # LOAD → SELECT → SAMPLE → UPDATE
      persist.ts          # MEMORY.WRITE / UPDATE
      deliver.ts          # INTERACTION.OUTPUT
    plans/
      conversation.ts     # Generator plan for one runtime.loop call
    tools/                # APIs, files, browser and MCP adapters
    storage/              # Redis, SQL and vector database adapters
    skills/               # Trusted instructions and references
  data/                   # Databases and artifacts; use persistent storage
```

A small project can keep its Graphs and plan in one file. Split out a stage when several tasks reuse it. Directory names are not auto-discovery conventions: explicitly import and register resources.

## 3. Run the complete example

[Download the examples](examples.en.md), extract them and run:

```sh
npm install
cp examples/package-basics/.env.example .env
# Configure the actual provider, model and Redis address in .env.
redis-server --bind 127.0.0.1 --port 6379
```

Keep Redis running in that terminal. Submit requests from another terminal:

```sh
node --env-file=.env examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt 'Remember that my project code is orchid-42.'
node --env-file=.env examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt 'What is my project code?'
```

Each command starts a new process. The second turn restores SQLite history instead of relying on variables from the previous process. The default `.examples-package-basics-tasks/alice` directory contains `memory.sqlite` and `answers/turn-2.md`. The CLI returns the answer, file path and `replayed` flag.

In a source checkout, first run `npm ci` and `npm ci --prefix examples/_shared/tools/storage/dependencies`, then the same CLI commands. The repository prepare script builds packages; the consumer archive does not compile framework source.

## 4. What happens inside a request

```text
Trusted controller validates session / turn / prompt
                    ↓
       runtime.loop(conversationPlan)
                    ↓
          History Graph: MEMORY.GET
                    ↓
    Last completed turn matches input? ── yes ─────────┐
                    │ no                              │
                    ↓                                 │
          Answer Graph                                │
          CONTEXT.LOAD(scope,sources)                  │
            → CONTEXT.SELECT                          │
            → INFER.REASONING.SAMPLE                   │
            → CONTEXT.UPDATE                          │
                    ↓                                 │
          Persist Graph                               │
          MEMORY.WRITE / UPDATE                       │
                    ↓                                 ↓
          Deliver Graph → INTERACTION.OUTPUT
```

Declare dependencies within a stage in its Graph. Schedule stages through `yield* graphStep(...)` in the Loop. The application plan does not invoke Worker executors outside the Runtime.

## 5. Application entry point

The complete [agent.ts](../../examples/package-basics/agent.ts) includes input validation, result checks, cleanup, bounded history and replay of the latest turn.

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { runAgent } from "./examples/package-basics/agent.ts";

const config = loadRuntimeConfig(process.env, {
  runtime: { timeoutMs: 60_000 },
  workers: { context: { cache: { ttlMs: 300_000 } } },
});
const result = await runAgent(
  { session: "alice", turn: "turn-3", prompt: "Describe this project using our history." },
  "./data",
  config,
);
console.log(result.answer, result.file);
```

`runAgent` is an application function you can copy, not a main-package export. In a service, choose the session and storage directory after authentication. Do not let a model or arbitrary HTTP parameter choose database file paths.

## 6. Adapt the example

| Change | Location | Constraint to retain |
| --- | --- | --- |
| Output style or role | System instructions in the Answer Graph | User and web content must not become system instructions |
| Retrieve more history | Add MEMORY.SEARCH to the History Graph | Check NodeResult and map ContextItem explicitly |
| Add tools | Register tools and add ACT.TOOL/OBSERVE | Enforce permissions, validation, idempotency and timeouts |
| Autonomous iterations | Replace conversationPlan | Schedule Graphs through one Loop with shared budgets |
| Change database | Replace the storage adapter | Preserve MemoryStore contracts and error semantics |
| Publish to a business system | Replace OutputSink or add a publishing tool | Verify receipts and actual external state |

## 7. Recovery scope

This starter retains replay state for the latest turn and at most five turns of conversation history. It rejects a repeated turn with a different prompt. Serialize requests within a session. It does not implement multi-tenant authentication, arbitrary historical replay or automatic rollback across business transactions.

For durable checkpoints, side-effect reconciliation and cross-process stage recovery, use [4.16 Long-running tasks](../../examples/patterns/long-running/README.md). Track task state, long-term Memory and the business operation ledger separately.

Next: [Graph and Loop](graph-loop.en.md) → [Models](models.en.md) → [Tools](tools.en.md).
