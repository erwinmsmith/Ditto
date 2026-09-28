# Choose and run examples

The examples progress from basic calls through control flows and Agent capabilities to complete execution patterns. Each directory describes inputs, dependencies, commands, artifacts, failures and validation. Third-party tools and database adapters live in `_shared/tools`, outside framework dependencies.

## 1. Download consumer examples

The documentation build produces [ditto-examples.zip](/downloads/ditto-examples.zip). Extract it, read its README and run `npm install`. It installs Ditto from npm without framework source or path aliases.

```sh
unzip ditto-examples.zip -d ditto-examples
cd ditto-examples
npm install
node examples/package-basics/context.ts 'Hello Ditto'
node examples/package-basics/tools.ts 'A😀'
```

For model-backed tasks, copy `examples/package-basics/.env.example` to `.env` and configure the model and Redis. Follow each example README for database, browser, OCR, audio and MCP dependencies. The archive excludes secrets, node_modules, databases, test artifacts and framework source.

The repository's `npm run build` compiles the framework. The consumer archive has no framework build step and strips it from example scripts. Maintainer `check:*:package` commands require the source checkout and are not consumer commands.

## 2. Start small

| Example | Dependencies | Result |
| --- | --- | --- |
| [Context](../../examples/package-basics/context.ts) | Main package | Actual LOAD → SELECT output |
| [Tool](../../examples/package-basics/tools.ts) | Main package | Character count and Observation |
| [Conversation Agent](../../examples/package-basics/agent.ts) | Model, Redis, file SQLite | Persistent conversation, recovery, replay and answer file |
| [Optional retrieval](../../examples/package-basics/retrieval.ts) | Main and retrieval packages | Candidates and sources |
| [Integrations and extensions](../../examples/handbook/README.md) | Per example | Custom Worker, Skill, Memory ranking and real MCP |

## 3. Seven control-flow groups

[Sequence](../../examples/control-flow/sequence/README.md), [conditions/routing](../../examples/control-flow/routing/README.md), [parallelism/aggregation](../../examples/control-flow/parallel/README.md), [iteration](../../examples/control-flow/iteration/README.md), [recovery](../../examples/control-flow/recovery/README.md), [human control](../../examples/control-flow/human/README.md) and [lifecycle](../../examples/control-flow/lifecycle/README.md).

Choose the control structure, then its Nodes; each business flow does not need a new framework API. The [public-call boundary](../worker-api/control-flow.md) maps 38 examples to public Nodes.

## 4. Twelve capability groups

The [capability index](../../examples/capabilities/README.md) covers request understanding, planning, retrieval, analysis, context, memory, system operations, result interpretation, content, multimodal understanding, data/code, and validation/safety.

Choose the business entry point and read its `_shared/tools` adapters. Context uses Redis and Memory uses persistent storage; business systems still need independent state checks. The [capability composition reference](../worker-api/capability-composition.md) maps 86 entry points to APIs.

## 5. Sixteen complete execution patterns

| Pattern | Prerequisites | Complete chain |
| --- | --- | --- |
| [4.1 RAG](../../examples/patterns/rag-qa/README.md) | Context, Memory, retrieval | Question to cited answer |
| [4.2 Web Q&A](../../examples/patterns/web-search-qa/README.md) | Tools, page reading | Search, read, filter and cite |
| [4.3 Deep research](../../examples/patterns/deep-research/README.md) | Loop, budgets | Subquestions, repeated search, gaps and report |
| [4.4 ReAct](../../examples/patterns/react/README.md) | INFER actions, Tool/MCP | Decide, act and observe until stopping |
| [4.5 Plan-and-Execute](../../examples/patterns/plan-and-execute/README.md) | Graph dependencies, dynamic Loop | Plan, execute and replan |
| [4.6 Reflection](../../examples/patterns/reflection/README.md) | Checks, versions | Generate, critique, revise and recheck |
| [4.7 Candidate selection](../../examples/patterns/candidate-selection/README.md) | Parallelism, deliberation | Generate, evaluate, choose or combine |
| [4.8 Tool chain](../../examples/patterns/tool-chain/README.md) | Tools, side effects | Customer/order lookup, update and notify |
| [4.9 Human-in-the-loop](../../examples/patterns/human-in-the-loop/README.md) | Persistence, trusted approval | Stage output, human edit and continuation |
| [4.10 Multi-Agent](../../examples/patterns/multi-agent/README.md) | Role context, parallelism | Assign, execute, collect and aggregate |
| [4.11 Supervisor](../../examples/patterns/supervisor/README.md) | Review, budgets, reassignment | Supervisor review and further delegation |
| [4.12 Handoff](../../examples/patterns/handoff/README.md) | Atomic responsibility state | Transfer ownership, acknowledge and recover |
| [4.13 Specialist routing](../../examples/patterns/specialist-routing/README.md) | Conditions, permissions | Classify domain and constrain execution |
| [4.14 Debate](../../examples/patterns/debate/README.md) | Independent context, sources | Agreement, disagreements and synthesis |
| [4.15 Auto-repair](../../examples/patterns/auto-repair/README.md) | Actual execution feedback | Error, change and rerun validation |
| [4.16 Long-running recovery](../../examples/patterns/long-running/README.md) | Checkpoints, business idempotency | Interrupt, reconcile, resume and deliver |

## 6. Reuse an example

Copy the pattern directory and its relative `_shared` application imports, preserving layout. Replace identity, sources, tools, output sinks and configuration; retain stage contracts, validation and recovery rules.

Copying only cli.ts is usually insufficient. The archive preserves paths so you can run it before removing unused parts. Functions such as runRag are application entry points, not framework npm exports.

## 7. Verify actual completion

Record the real environment, model, storage and external systems. Check final files/database/remote state. Test new tasks, replay, errors, cancellation, unavailable services and process recovery separately. TypeScript success or a model response alone does not establish end-to-end task success.
