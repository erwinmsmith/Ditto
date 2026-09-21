# Example guide

**English** · [简体中文](README.zh-CN.md) · [Worker API](../docs/worker-api/README.md)

This directory contains complete executable flows. Start with `graph-loop-worker.ts` to understand Graph, Loop, and Worker responsibilities, then use `interaction-tools.ts` for real commands and tool composition.

## Examples

| File | Purpose | Command | Requirements |
| --- | --- | --- | --- |
| [graph-loop-worker.ts](graph-loop-worker.ts) | Compose file inspection, observation, and output in a Graph; iterate over two files with a Loop; implement the tool inside a Worker | `npm run example:agent` | Node 24+, npm 11+; no model, database, or MCP setup |
| [interaction-tools.ts](interaction-tools.ts) | Register Linux/macOS operations as one tool, compose it with SHA-256, and run two command inputs | `npm run example:tools` | Same runtime; Linux or macOS with uname / printf |

Run all commands from the **repository root**. Install dependencies first:

```bash
npm ci
```

Both example commands build the package before running TypeScript. Both configure Workers and Sandbox explicitly in code, without reading `.env` or `ditto.yaml` or requiring model credentials.

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

Linux/macOS interaction is one `linux` tool with an injected executor. A second tool consumes its output in the same Worker/Graph.

```text
linux tool → OBSERVE → sha256 tool → OBSERVE → OUTPUT
```

| Export | Responsibility |
| --- | --- |
| `commandExecutor` | Execute using Node execFile, separate command/args, workspace, timeout, and output limit |
| `linuxTool` | Validate arguments, call SandboxExecutor, return stdout/stderr/exitCode, and report nonzero exits as failed |
| `sha256Tool` | Hash text from the preceding tool |
| `CommandInput` | Graph input: id, command, args |
| `commandGraph` | Command plus OBSERVE, reusable as the start of another flow |
| `toolGraph` | Extend commandGraph with hashing, observation, and output |

```bash
npm run example:tools
```

The Loop executes:

1. `uname -s`: returns Darwin on macOS or Linux in Linux; hashes raw stdout including its trailing newline.
2. `printf`: prints `Ditto: spaces; $(uname) stay literal` literally and hashes it. No shell is started, so command substitution does not execute.

Two JSON lines use delivery IDs `os:delivery` and `literal:delivery`. Messages contain the command result and SHA-256 digest. A failed command prevents hashing.

The example executor enables only uname, printf, pwd, and false; the latter two are used by integration tests. It limits execution to 5 seconds and output to 64 KiB. This is explicit local process execution, not OS isolation. Inject a container or SSH executor for other deployment needs without changing the Tool contract or adding a linux-commands directory.

The example runs only when invoked directly. Importing its exported executor, tools, or Graphs does not execute commands.

## API examples and live checks

| Entry | Purpose | Usage |
| --- | --- | --- |
| [API example guide](../docs/worker-api/examples/README.md) | MEMORY, INFER, INTERACTION, and optional RETRIEVAL; individual function explanations | Inject application resources and call the chosen function; these are not automatically executed applications |
| [MCP live script](../scripts/check-interaction-mcp-live.mjs) | Real command → MCP file read → SHA-256 → OUTPUT | Install optional SDKs as described in the [live report](../docs/worker-api/interaction-live-report.md), then run `npm run check:interaction:mcp:live -- <dependency-directory>` |
| [INFER live script](../scripts/check-infer-live.ts) | Validate sampling and reasoning against configured real models | Configure `.env` per the [live report](../docs/worker-api/infer-live-report.md), then run `npm run check:infer:live -- --provider <name>` |

Use `npm run typecheck` for source checks and `npm run check` for the full project checks. Linux/macOS command and MCP execution results are recorded in the [live report](../docs/worker-api/interaction-live-report.md).
