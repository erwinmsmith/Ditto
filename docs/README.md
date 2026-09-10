# Documentation Map

Start with the architecture and development guides, then follow the references for Worker communication, configuration, and capability extensions. The linked guides are currently written in Chinese.

## Guides

| Document | Contents |
| --- | --- |
| Project overview: [English](../README.md) / [Chinese](../README.zh-CN.md) | Project goals, capabilities, and setup |
| [Architecture](architecture.md) | Worker ownership, internal Nodes, Graph execution, scaling, and module boundaries |
| [Development and Integration](getting-started.md) | Installation, checks, package entry points, and custom Workers and Nodes |
| [Worker Communication](worker-communication.md) | Local and remote calls, HTTP deployment, lifecycle, events, and artifacts |
| [Interaction and Runtime Configuration](interaction-runtime.md) | Providers, models, credentials, tools, MCP, Skills, and Sandbox permissions |
| [Node API Contract v1.0](13-node-api-contract.md) | The original 18 Node input/output contracts; legacy class definitions are not part of the current API |
| [Environment Variables](../.env.example) | Configuration template |

## Source Reference

| Source | Guide |
| --- | --- |
| `src/contracts/` | [Architecture](architecture.md): shared data types and the Node contract interface |
| `src/worker/*/contracts.ts`, `src/worker/node.ts` | [Development and Integration](getting-started.md): Worker-owned contracts and typed handlers |
| `src/worker/define-worker.ts`, `src/runtime/graph.ts`, `src/runtime/router.ts` | [Architecture](architecture.md): composition, execution, and routing |
| `src/runtime/communication/`, `src/runtime/artifact.ts` | [Worker Communication](worker-communication.md) |
| `src/runtime/config.ts`, `src/runtime/services.ts`, `src/runtime/sandbox/` | [Interaction and Runtime Configuration](interaction-runtime.md): configuration and permissions |
| `src/worker/reasoning/providers/` | [Interaction and Runtime Configuration](interaction-runtime.md): model providers |
| `src/worker/interaction/` | [Interaction and Runtime Configuration](interaction-runtime.md): tools, MCP, Skills, and the interaction loop |
