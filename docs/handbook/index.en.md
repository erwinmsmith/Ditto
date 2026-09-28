# Ditto developer handbook

Ditto defines an Agent operation as a **Node**, puts implementations and resources in a **Worker**, declares dependencies in a **Graph**, and uses a **Loop** to control stages, branches, repetition and recovery. Applications can replace models, tools, databases and deployment locations while keeping the same Graph.

This handbook is for npm consumers. Framework calls use public exports from `@codesoul-co/ditto`; optional retrieval comes from `@codesoul-co/ditto-retrieval`. Business controllers, third-party SDKs and database adapters in the examples belong to the application.

## Start with your task

| Task | Reading order | What you will build |
| --- | --- | --- |
| First execution | [Installation](../package-guide.md) → [Project structure](agent.en.md) | An executable Graph and a complete Redis/SQLite conversation Agent |
| Connect tools to a model | [Models](models.en.md) → [Tools](tools.en.md) → [Graph/Loop](graph-loop.en.md) | Model action requests, tool execution, observation and another decision |
| Connect an MCP server | [MCP](mcp.en.md) → [INTERACTION](../worker-api/interaction.md) | A real connection, discovery, invocation and client cleanup |
| Use skills and working context | [Skills](skills.en.md) → [CONTEXT](../worker-api/context.md) | A trusted skill catalog, permissions, selection and budgets |
| Add persistent memory | [Memory algorithms](memory.en.md) → [MEMORY API](../worker-api/memory.md) | Database setup, writes, updates, search and recovery boundaries |
| Answer questions about documents | [Retrieval](retrieval.en.md) → [RAG example](../../examples/patterns/rag-qa/README.md) | Request → retrieval → Context → generation → citations → durable delivery |
| Extend the framework | [Workers and Nodes](extensions.en.md) → [Deployment](deployment.en.md) | Contracts, handlers, resources, registration, private nodes and routing |

## Recommended reading path

1. **Run a small Graph.** Install the main package and run the Context example without external services. Check Node.js, ESM and imports.
2. **Connect resources.** Configure a real model, Redis and file SQLite. Execute a request through to an answer file.
3. **Understand orchestration.** Use a Graph for each stage and one Loop for stages and subplans. Define failures, timeouts and budgets.
4. **Explore each Worker.** Learn inputs, outputs, defaults, replaceable services and errors. Install the adapters you need.
5. **Extend the application.** Wrap SDKs as Providers, Tools or Stores. Add a Node when you need a new semantic operation.

## Package responsibilities

| Layer | Responsibility | Application work still required |
| --- | --- | --- |
| Runtime | Registration, routing, execution, cancellation and transport | Authentication and database connection setup |
| Graph | Dependencies, input binding and readiness for parallel execution | Dynamic choices between stages |
| Loop | Graph selection, repetition, stopping and stage changes | Persisting application checkpoints; generator stacks are not serialized |
| Worker | Node implementations and replica resources | Explicit import and registration; folders do not auto-load plugins |
| Application | Identity, connections, business state, policy and delivery | Configuration and verification of actual business effects |

## How the documentation fits together

This handbook explains how to build applications. The [Worker API](../worker-api/README.md) documents parameters, return values, defaults and calls. The [example catalog](examples.en.md) provides complete tasks from input to artifact, readable source pages and a downloadable npm consumer project.

English is the default site language. Use the language menu to open the same topic in Simplified Chinese. Both languages document the same public contracts.
