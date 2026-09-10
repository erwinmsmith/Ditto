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
| **On-demand scaling** | Add development nodes as workload and task complexity grow. |
| **Low-cost evolution** | Make local changes to agent responsibilities and node composition with less rework across the system. |

## The node model

A development node is intended to be a composable unit of agent capability. Nodes provide a way to organize work while allowing the overall agent structure to evolve.

- **Start small.** Define only the nodes needed for the current workflow.
- **Expand as needed.** Add nodes when new capabilities or more capacity are required.
- **Evolve incrementally.** Adjust responsibilities and how nodes work together as the workflow changes.

This is the conceptual model guiding the project; implementation details are still being developed.

## Project status

Ditto is in its early stages. This repository currently contains the project introduction and logo. The goals above describe the intended direction; a runnable framework, installation instructions, and usage examples are not yet available.

## Feedback

Use [GitHub Issues](https://github.com/erwinmsmith/Ditto/issues) to share use cases, discuss the node model, or suggest improvements. Concrete examples of how your agent workflow needs to scale or change are especially useful.
