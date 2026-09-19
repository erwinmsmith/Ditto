# Documentation Map

**English** · [简体中文](README.zh-CN.md)

Start with the architecture and development guides, then follow the references for Worker communication, configuration, and capability extensions. Every guide is available in English and Simplified Chinese.

## Guides

| Document | English | 简体中文 | Contents |
| --- | --- | --- | --- |
| Project overview | [Read](../README.md) | [阅读](../README.zh-CN.md) | Project goals, capabilities, and setup |
| Architecture | [Read](architecture.md) | [阅读](architecture.zh-CN.md) | Worker ownership, internal Nodes, Graph/Loop execution, scaling, and module boundaries |
| Development and Integration | [Read](getting-started.md) | [阅读](getting-started.zh-CN.md) | Installation, checks, package entry points, and custom Workers and Nodes |
| Implemented Worker APIs | [Read](worker-api/README.md) | [阅读](worker-api/README.zh-CN.md) | INFER contracts, invocation, strategies, streaming and cache |
| Worker Communication | [Read](worker-communication.md) | [阅读](worker-communication.zh-CN.md) | Local and remote calls, HTTP deployment, lifecycle, events, and artifacts |
| Interaction and Runtime Configuration | [Read](interaction-runtime.md) | [阅读](interaction-runtime.zh-CN.md) | Providers, models, credentials, tools, MCP, Skills, and Sandbox permissions |
| Node Taxonomy and API Contract | [Read](13-node-api-contract.md) | [阅读](13-node-api-contract.zh-CN.md) | Final capability tree, common public types, 25 executable leaf Contracts, and Runtime predefined flows |
| Node Coverage | [Read](node-coverage.md) | [阅读](node-coverage.zh-CN.md) | Six existing cases remapped to the final taxonomy with evidence boundaries |

The [environment variable template](../.env.example) uses bilingual comments.

## Source Reference

| Source | Guide |
| --- | --- |
| `src/contracts/` | [Architecture](architecture.md): shared data types and the Node contract interface |
| `src/worker/*/contracts.ts`, `src/worker/node.ts` | [Development and Integration](getting-started.md): Worker-owned contracts and typed handlers |
| `src/worker/define-worker.ts`, `src/runtime/graph.ts`, `src/runtime/router.ts` | [Architecture](architecture.md): composition, execution, and routing |
| `src/runtime/loop.ts` | [Architecture](architecture.md#loop-execution): state, per-round Graph selection, and bounded execution |
| `src/runtime/communication/`, `src/runtime/artifact.ts` | [Worker Communication](worker-communication.md) |
| `src/runtime/config.ts`, `src/runtime/services.ts`, `src/runtime/sandbox/` | [Interaction and Runtime Configuration](interaction-runtime.md): configuration and permissions |
| `src/worker/infer/providers/` | [Interaction and Runtime Configuration](interaction-runtime.md): vendor-neutral model Provider adapters |
| `src/worker/interaction/` | [Interaction and Runtime Configuration](interaction-runtime.md): leaf tool/MCP/Skill capabilities and application Graph + Loop composition |

## Language Convention

Use `.md` for English and `.zh-CN.md` for Simplified Chinese. Each document links to its counterpart at the top. Update both versions together, preserving matching sections, API definitions, and examples. Keep navigation focused on user-facing documentation.
