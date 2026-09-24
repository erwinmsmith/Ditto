# Ditto examples

[Handbook examples](handbook/README.md): custom Workers, Skills, database ranking and real MCP.

[简体中文](README.zh-CN.md) · [Project](../README.md) · [API reference](../docs/worker-api/README.md)

This catalog organizes Agent topics into control flow, capabilities and execution patterns, describing how individual operations compose into task workflows.

## Directory guide

| Directory | Contents |
| --- | --- |
| [package-basics](package-basics/README.md) | npm installation, Context, tools, optional retrieval and a persistent conversation Agent |
| [control-flow](control-flow/README.md) | 7 categories: sequencing, routing, parallelism, iteration, recovery, human intervention and lifecycle |
| [capabilities](capabilities/README.md) | 12 categories of reusable Agent capabilities |
| [patterns](patterns/README.md) | 16 execution patterns, including RAG, ReAct, research and multi-Agent coordination |
| [_shared](_shared/README.md) | Common configuration and static inputs |

Each directory guide describes its topics, workflows and API boundaries. [quickstart.ts](quickstart.ts) provides a local runnable introduction; see the API examples below for model, database and deployment integration code.

## Quickstart

Use Node.js 24+ and npm 11+, from the repository root:

```bash
npm ci
npm run example:quickstart
```

This runs CONTEXT.LOAD → SELECT and returns a selection containing `Hello Ditto`, without model credentials or external services. Importing the module does not run it.

## Organization

Keep individual topics in separate files and each pattern in its own directory. Use public package exports and keep Graph, Loop and state transitions visible within each example. Place common configuration and inputs in `_shared/`.

Applications own approval, retry, checkpoint persistence and task handoff. Agent roles and Worker deployment boundaries are separate concepts. Configure external services explicitly, supply credentials through environment variables and close resources in `finally`.

Run `npm run typecheck` from the repository root to check TypeScript types.

## Validation requirements

Acceptance covers input, Graph scheduling, real dependencies, result validation and final output. Model workflows must use real providers. Control-flow examples compose real model steps to verify that upstream data participates in inference. Database, tool and other service examples exercise their actual integration paths.

Unit tests and type checks provide fast regression coverage. Run end-to-end checks with a separate command that explicitly loads credentials and records the provider or service, timing, key inputs/outputs and pass/fail results. Fail with a nonzero exit code rather than substituting doubles or fixed answers. Use public package entrypoints and verify type resolution and execution against an installed package.

See [real-model sequence validation](control-flow/sequence/README.md#real-model-end-to-end-validation) for the runnable acceptance command.

## API integration examples

The [API examples](../docs/worker-api/examples/README.md) document public interfaces and service integration. See the [setup guide](../docs/worker-api/examples/guide.md), [Runtime examples](../docs/worker-api/examples/runtime/README.md) and [database integrations](../docs/worker-api/examples/integrations/README.md).

See [six routing examples](control-flow/routing/README.md) for execution and real-model acceptance checks.


Task acceptance ends at a business outcome. Successful inference, a successful tool status or a finished Graph is only intermediate evidence. Run from actual inputs to inspectable artifacts or explicit failure, blocking, approval or human-queue states. File workflows must decode/OCR/transcribe real files; writes must be read back, approvals must cover accept/reject/resume, and retries must verify that effects are not duplicated. Reopen persistent stores to verify durability.

Full routing task acceptance: `npm run check:examples:routing:tasks:package`. See [file ingestion tools](_shared/tools/file-ingestion/README.md) for installation and configuration.

Parallel task acceptance: `npm run check:examples:parallel:tasks:package`; see [four parallel workflows](control-flow/parallel/README.md).

Iteration task acceptance: `npm run check:examples:iteration:tasks:package`; see [six loop workflows](control-flow/iteration/README.md).

Recovery task acceptance: `npm run check:examples:recovery:tasks:package`; see [eight recovery workflows](control-flow/recovery/README.md).

[Human intervention APIs and examples](control-flow/human/README.md): approval before execution, intermediate confirmation, edited continuations, reviewed publication and human handoff.

[Task lifecycle APIs and examples](control-flow/lifecycle/README.md): state tracking, guarded execution, safe stopping, scheduled triggers and event triggers.

[Public API boundaries and unified package acceptance](../docs/worker-api/control-flow.md): capability mapping for 38 examples, strict external consumer types and real task verification.

[Request understanding and interaction](capabilities/understanding/README.md): six capabilities and complete report tasks; package verification: `npm run check:examples:understanding:tasks:package`.

[Context / Memory storage](_shared/tools/storage/README.md): Agent examples use Redis Context and database Memory, with separate business state. Subsequent examples follow the same storage and end-to-end verification contract.

[Planning and task management](capabilities/planning/README.md): five capabilities and actual replenishment tasks; package verification: `npm run check:examples:planning:tasks:package`.

[Document and multimodal understanding](capabilities/multimodal/README.md): eight capabilities, real media parsing and complete tasks; package gate `npm run check:examples:multimodal:tasks:package`.

[Data and code capabilities](capabilities/data-and-code/README.md): twelve workflows and complete task acceptance; `npm run check:examples:data-code:tasks:package`.

[Validation and safety](capabilities/validation/README.md): nine workflows, enforced publication gates and complete task acceptance; `npm run check:examples:validation:tasks:package`.

See [public API composition](../docs/worker-api/capability-composition.md) for the unified release gate across all Agent capabilities.
