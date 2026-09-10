# Documentation Map

**English** · [简体中文](README.zh-CN.md)

Start with the architecture and development guides, then follow the references for Worker communication, configuration, and capability extensions. Every guide is available in English and Simplified Chinese.

## Guides

| Document | English | 简体中文 | Contents |
| --- | --- | --- | --- |
| Project overview | [Read](../README.md) | [阅读](../README.zh-CN.md) | Project goals, capabilities, and setup |
| Architecture | [Read](architecture.md) | [阅读](architecture.zh-CN.md) | Worker ownership, internal Nodes, Graph execution, scaling, and module boundaries |
| Development and Integration | [Read](getting-started.md) | [阅读](getting-started.zh-CN.md) | Installation, checks, package entry points, and custom Workers and Nodes |
| Worker Communication | [Read](worker-communication.md) | [阅读](worker-communication.zh-CN.md) | Local and remote calls, HTTP deployment, lifecycle, events, and artifacts |
| Interaction and Runtime Configuration | [Read](interaction-runtime.md) | [阅读](interaction-runtime.zh-CN.md) | Providers, models, credentials, tools, MCP, Skills, and Sandbox permissions |
| Node API Contract v1.0 | [Read](13-node-api-contract.md) | [阅读](13-node-api-contract.zh-CN.md) | The original 18 Node input/output contracts; legacy class definitions are not part of the current API |

The [environment variable template](../.env.example) uses bilingual comments.

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

## Language Convention

Use `.md` for English and `.zh-CN.md` for Simplified Chinese. Each document links to its counterpart at the top. Update both versions together, preserving matching sections, API definitions, and examples. Keep navigation focused on user-facing documentation.
