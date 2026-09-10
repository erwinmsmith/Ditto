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

## Overview

Ditto is an agent-native development node framework built around a simple idea: your agent system should be able to grow and change with the work it does.

The framework aims to make development capabilities composable as nodes, expand capacity when needed, and reduce the effort required to update agent structures. Start with a small setup, then adapt its capabilities and organization as requirements evolve.

## Design goals

| Goal | What it means |
| --- | --- |
| **Agent-native** | Treat agents as first-class participants in the development workflow, with nodes as the units for organizing their capabilities. |
| **On-demand scaling** | Add Worker instances as workload and task complexity grow. |
| **Low-cost evolution** | Make local changes to agent responsibilities and node composition with less rework across the system. |

## The node model

A development node is intended to be a composable unit of agent capability. Nodes provide a way to organize work while allowing the overall agent structure to evolve.

- **Start small.** Define only the nodes needed for the current workflow.
- **Expand as needed.** Add Nodes for new semantic capabilities and Worker instances for more capacity.
- **Evolve incrementally.** Adjust responsibilities and how nodes work together as the workflow changes.

The initialized runtime separates semantic Nodes, Worker instances, logical Execution Graphs, and Runtime execution. Capacity scales through Worker replicas; changing a model or database implementation does not require a new Node Type.

## Project status

Ditto now contains a lightweight TypeScript framework initialization: typed Node Contracts, declarative Workers, capability-aware routing, DAG execution, invoke/emit communication, and Inline/Reference payload support. The fixed Node API remains at version 1.0.

Core has no third-party runtime dependencies. The package is private and has not been published to npm. Production IPC/RPC, distributed deployment, and automatic scaling controllers remain optional future work; transport boundaries are currently verified with test adapters.

## Development

Requirements: Node.js 24+ and npm 11+.

```bash
npm ci
npm run check
```

The check runs strict type checking, 15 tests, and a clean build. For local dependency consumption and the runnable example:

```bash
npm --prefix examples/experimental-consumer ci
npm --prefix examples/experimental-consumer run check
```

- [Development and integration guide (Chinese)](docs/getting-started.md)
- [Architecture and current boundaries (Chinese)](docs/architecture.md)
- [Architecture review and decisions (Chinese)](docs/architecture-review-2026-09-09.md)
- [Fixed Node API contract (Chinese)](docs/13-node-api-contract.md)

## Feedback

Use [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) to share use cases, discuss the node model, or suggest improvements. Concrete examples of how your agent workflow needs to scale or change are especially useful.
