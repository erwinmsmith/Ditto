# Example guide

**English** · [简体中文](guide.zh-CN.md) · [Worker API](../README.md)

This directory contains complete executable flows. Start with `graph-loop-worker.ts` to understand Graph, Loop, and Worker responsibilities, then use `interaction-tools.ts` for real commands and tool composition.

## Examples

| File | Purpose | Command | Requirements |
| --- | --- | --- | --- |
| [graph-loop-worker.ts](graph-loop-worker.ts) | Compose file inspection, observation, and output in a Graph; iterate over two files with a Loop; implement the tool inside a Worker | `npm run example:agent` | Node 24+, npm 11+; no model, database, or MCP setup |
| [interaction-tools.ts](interaction-tools.ts) | Register the optional read-only commands plus a low-level command example, then compose command output with SHA-256 | `npm run example:tools` | Same runtime; Linux or macOS with grep / uname / printf |
| [runtime/quickstart.ts](../../../examples/quickstart.ts), [api.ts](runtime/api.ts), [flows.ts](runtime/flows.ts) | Starter and public APIs: custom nodes, lifecycle, events/artifacts and flows | `npm run example:runtime:quickstart` / `example:runtime:api` / `example:runtime:flows` | Local entrypoints need no external service; MCP/ReAct functions need injected services |
| [runtime/](runtime/README.md) | Multiple graphs, independent Worker sandboxes, local IPC and cross-host HTTP | `npm run example:runtime` / `npm run example:runtime:placement` | No additional SDK or service |
| [worker/](integrations/README.md) | CONTEXT with Redis; MEMORY with SQLite/PostgreSQL/MySQL/Milvus | See subfolder commands | Optional SDKs and database connections |

Run all commands from the **repository root**. Install dependencies first:

```bash
npm ci
```

The first two example commands build the package before running TypeScript. Both configure Workers and Sandbox explicitly in code, without reading `.env` or `ditto.yaml` or requiring model credentials.

## graph-loop-worker.ts: minimal Agent execution

Learn how Graph, Loop, and Worker implementations form a complete flow.

| Component | Responsibility |
| --- | --- |
| `inspect` Graph | Compose ACT.TOOL → OBSERVE → OUTPUT; bind paths, call IDs, and observations |
| `inspectFiles` Loop | Maintain paths/index; process two files and stop |
| `inspect_text` tool | Read real files through Sandbox; count characters and newline-separated segments |
| Interaction Worker | Register inspect_text and a console OutputSink |
| Runtime | Grant tool/read permissions, run the Loop, then close |

```bash
npm run example:agent
```

Reads `README.md` and `package.json` and prints two JSON lines. Each contains a deliveryId and assistant message with path, characters, and lines. Counts vary with file contents. Neither input file is modified.

Change paths and maxIterations together to inspect other workspace files. Replace execute to supply another capability, then extend the Graph for additional processing. This file runs at the top level: **importing it also runs the example**. Use it as an executable or application entry-point reference.

## interaction-tools.ts: system commands and ordinary tools

The example explicitly registers all 14 reusable read-only command tools and a lower-level `linux` tool with the same injected executor. A SHA-256 tool consumes low-level command output in the same Worker/Graph.

```text
linux tool → OBSERVE → sha256 tool → OBSERVE → OUTPUT
```

| Export | Responsibility |
| --- | --- |
| `commandExecutor` | Use createLocalSandboxExecutor with literal command/args, workspace, timeout and output limit |
| `readOnlyCommandTools` | The 14 optional bounded read-only command registrations from Core |
| `linuxTool` | Validate arguments, call SandboxExecutor, return stdout/stderr/exitCode, and report nonzero exits as failed |
| `sha256Tool` | Hash text from the preceding tool |
| `CommandInput` | Graph input: id, command, args |
| `commandGraph` | Command plus OBSERVE, reusable as the start of another flow |
| `toolGraph` | Extend commandGraph with hashing, observation, and output |

```bash
npm run example:tools
```

Before the Loop, `grep` searches README through ACT.TOOL and OBSERVE. The Loop then executes:

1. `uname -s`: returns Darwin on macOS or Linux in Linux; hashes raw stdout including its trailing newline.
2. `printf`: prints `Ditto: spaces; $(uname) stay literal` literally and hashes it. No shell is started, so command substitution does not execute.

The first JSON line is the grep Observation. Two later lines use delivery IDs `os:delivery` and `literal:delivery`; their messages contain the command result and SHA-256 digest. A failed command prevents hashing.

The example executor enables the 14 read-only commands plus uname, printf, and false; the latter commands support the lower-level example and integration tests. It limits execution to 5 seconds and output to 64 KiB. This is explicit local process execution, not OS isolation. Inject a container or SSH executor for other deployment needs without changing the Tool contract.

The example runs only when invoked directly. Importing its exported executor, tools, or Graphs does not execute commands.

## API examples and live checks

| Entry | Purpose | Usage |
| --- | --- | --- |
| [API example guide](README.md) | MEMORY, INFER, INTERACTION, and optional RETRIEVAL; individual function explanations | Inject application resources and call the chosen function; these are not automatically executed applications |
| [MCP live script](../../../scripts/check-interaction-mcp-live.mjs) | Real command → MCP file read → SHA-256 → OUTPUT | Install optional SDKs using the [MCP](#mcp) instructions below, then run `npm run check:interaction:mcp:live -- <dependency-directory>` |
| [INFER live script](../../../scripts/check-infer-live.ts) | Validate sampling and reasoning against configured real models | Configure `.env` using the [INFER](#infer) instructions below, then run `npm run check:infer:live -- --provider <name>` |
| [Web search live script](../../../scripts/check-interaction-web-search-live.mjs) | Brave Search → ACT.TOOL → OBSERVE → CONTEXT.UPDATE | Set `DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY`, then run `npm run check:interaction:web-search:live -- "query"` |

### Web search

The live script explicitly creates the Brave adapter and `web_search` Tool, grants the Tool plus the exact Brave origin, and verifies that real results become an Observation and one Context item. It prints normalized results but never the API key. Core does not read this environment variable; the script is the application layer that injects it.

```bash
DITTO_WORKER_INTERACTION_BRAVE_SEARCH_API_KEY="..." npm run check:interaction:web-search:live -- "Ditto agent runtime"
```

### MCP

Install the optional MCP SDK and filesystem server used by the script, then run the command, file-reading, and tool composition flow:

```bash
mcp_deps="$(mktemp -d)"
npm install --prefix "$mcp_deps" --no-audit --no-fund --ignore-scripts \
  @modelcontextprotocol/sdk@1.30.0 \
  @modelcontextprotocol/server-filesystem@2026.8.31
npm run check:interaction:mcp:live -- "$mcp_deps"
```

### INFER

Create `.env` from root [`.env.example`](../../../.env.example) and fill in provider settings; set reasoning parameters in [`ditto.yaml`](../../../ditto.yaml). See the [configuration API](../configuration.md) for fields. Use a provider name matching your configuration:

```bash
npm run check:infer:live -- --provider deepseek
```

Use `--strategies cot,tot,got` to select strategies, `--cases sample,tot` to select cases, and `--max-tokens 4096` to set the token budget for this run. `--report path` sets the output file; the default is the Git-ignored `.infer-live-results.json`.

## CONTEXT / Redis

`createContext()` runs explicit Context examples without a cache. Cached calls need application-provided Redis and its SDK. Run from the repository root:

```bash
redis_deps="$(mktemp -d)"
npm install --prefix "$redis_deps" --no-audit --no-fund --ignore-scripts redis@6.2.1
DITTO_WORKER_CONTEXT_REDIS_URL=redis://127.0.0.1:6379 npm run check:context:redis:live -- "$redis_deps"
```

Install `redis` in the application, construct a connection using the URL from `.env`, and inject it into the Worker. Load env explicitly with Node `--env-file=.env` or your application loader:

```ts
import { createClient } from "redis";
import { createContextWorker, createDitto, loadRuntimeConfigFile } from "@codesoul-co/ditto";
const config = loadRuntimeConfigFile("ditto.yaml", process.env);
const redis = createClient({ url: process.env.DITTO_WORKER_CONTEXT_REDIS_URL });
redis.on("error", () => { /* Application logging/health reporting. */ });
await redis.connect();
const runtime = createDitto({ config, workers: [createContextWorker({
  ...(config.context.policy ? { policy: config.context.policy } : {}),
  redis: { client: redis, ...config.context.cache },
})] });
try {
  const scope = { sessionId: "tenant-a:session-1" };
  await runtime.invoke("CONTEXT.LOAD", { scope, sources: [{ role: "user", content: "hello" }] });
  const selected = await runtime.invoke("CONTEXT.SELECT", { scope, purpose: "infer" });
  console.log(selected.context);
} finally {
  await runtime.close();
  await redis.quit();
}
```

[CONTEXT example functions](README.md#contextts) · [Complete API](../context.md)

## CONTEXT and RETRIEVAL composition

[worker/context-retrieval.ts](integrations/context-retrieval.ts) compares inline CONTEXT retrieval and an optional RETRIEVAL Worker using real SQLite FTS5. It includes local cache/queue resources, reference resolution and a LOAD → SELECT Graph. Run `npm run example:worker:context-retrieval` without external credentials; see the [Worker example guide](integrations/README.md#context-caching-and-optional-retrieval).

`interaction-tools.ts` reuses Core's createLocalSandboxExecutor, with timeoutMs/maxOutputBytes from runtime.sandbox in root YAML, instead of maintaining a second process implementation. Run `npm run example:tools` for the command → OBSERVE → SHA-256 → OUTPUT Graph/Loop.
