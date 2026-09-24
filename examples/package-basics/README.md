# npm package basics

[简体中文](README.zh-CN.md) · [Complete package guide](../../docs/package-guide.md) · [Examples](../README.md)

These examples run from the repository or from an independent npm consumer. Framework imports use only public `@codesoul-co/ditto` and optional `@codesoul-co/ditto-retrieval` entries. Importing an example does not execute its task.

| Entry | Demonstrates | Dependencies and acceptance result |
| --- | --- | --- |
| [context.ts](context.ts) | Context LOAD → SELECT and Graph dependencies | Main package; returns the supplied text in a ContextSelection |
| [tools.ts](tools.ts) | Tool registration, validation, Sandbox allowlist, observation | Main package; counts Unicode code points |
| [retrieval.ts](retrieval.ts) | Optional package, target registry, provider, source references | Retrieval package; returns matching documents or an empty list |
| [agent.ts](agent.ts) | One Loop owning multiple Graphs, conversation persistence and output | Real model, Redis Context, file SQLite Memory; saves an answer file and conversation |

The first three are focused API/adapter introductions. The Agent is the complete task with a real model, storage and a verifiable artifact.

## Run from the repository

```sh
npm ci
node examples/package-basics/context.ts 'Hello Ditto'
node examples/package-basics/tools.ts 'A😀'
node examples/package-basics/retrieval.ts Redis
```

Context contains `Hello Ditto`; `counted.structuredContent.characters` is `2`; retrieval returns `context` with source `guide.md#context`. The retrieval provider searches two application documents by keyword. It does not create vectors or start a search database.

## Run the real Agent

```sh
npm ci --prefix examples/_shared/tools/storage/dependencies
cp examples/package-basics/.env.example .env.local
# Edit .env.local with your provider, model and network origin.
# Start Redis in another terminal, or configure an existing service.
redis-server --bind 127.0.0.1 --port 6379
```

```sh
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-1 --prompt 'Remember my project code orchid-42.'
node --env-file=.env.local examples/package-basics/agent.ts \
  --session alice --turn turn-2 --prompt 'What is my project code?'
```

Output resembles `{ "answer": "orchid-42", "file": "…/alice/answers/turn-2.md", "replayed": false }`. Model wording can vary. Use `--directory` to replace the default `.examples-package-basics-tasks` directory.

Repeat the latest turn with the identical prompt to replay its saved answer. Reusing that turn with another prompt is rejected. Use a new turn ID for each new request, and serialize calls for a session. The example keeps up to five previous turns for the next prompt and supports replay of the most recently completed turn. It does not provide concurrent session writes, authentication, tenant authorization or arbitrary historical replay; the application controller and advanced patterns supply those policies.

Memory commits before file output. If output fails, replay the latest turn. Model failure does not produce a completed Memory record. Redis outages fail the task; a new turn reconstructs expired Context from SQLite Memory.

## Call from code

```ts
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { runAgent } from "./examples/package-basics/agent.ts";

const result = await runAgent(
  { session: "alice", turn: "turn-1", prompt: "Summarize this requirement." },
  "./.examples-package-basics-tasks",
  loadRuntimeConfig(process.env, { runtime: { timeoutMs: 60_000 } }),
);
console.log(result.answer, result.file);
```

`runAgent` is an application function, not a package export. It creates and closes the Runtime, Redis and SQLite resources for that call. The trusted host supplies the session and directory, after authentication and session serialization when used in a service.

## Copy into an npm consumer

Install the main package and `redis@6.2.1`. Copy this directory, `../_shared/tools/package-basics.ts`, and storage's `workers.ts`, `redis-context.ts`, `sqlite-memory.ts`, `sql-memory.ts`, and `dependencies/package.json`, preserving relative locations. Install the retrieval package only for its example. The [package guide](../../docs/package-guide.md#10-copy-the-examples-into-your-project) includes exact commands, TypeScript configuration and environment setup.

## Verify

```sh
npm run check:package:basics
# Configure a real model and Redis in .env first:
npm run check:package:basics:live
```

The gate creates an external consumer, tests the main package alone, then installs retrieval. It validates every public entry, strict types, silent imports and actual task outputs. Live checks run two conversation turns and a replay in separate processes, expire Redis Context, and inspect SQLite records and answer files. They use a real model and do not equate SQLite coverage with verification of another database service.
